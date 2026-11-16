import type { API, DynamicPlatformPlugin, Logging, MatterAccessory, PlatformAccessory, PlatformConfig } from 'homebridge';

import { River3Accessory } from './accessory.js';
import { River3Device } from './ecoflow/device.js';
import { SimulatorTransport } from './ecoflow/simulator.js';
import { CloudTransport, type Transport } from './ecoflow/transport.js';
import { River3MatterAccessory } from './matterAccessory.js';
import {
  DEFAULT_API_HOST,
  KNOWN_SERIAL_PREFIXES,
  PLATFORM_NAME,
  PLUGIN_NAME,
  readDeviceConfig,
  readProtocol,
  type DeviceConfig,
} from './settings.js';

type MatterAPI = NonNullable<API['matter']>;

export class River3Platform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly cachedMatter = new Map<string, MatterAccessory>();
  private readonly devices: River3Device[] = [];
  /** The HomeKit accessories this platform is currently serving, by serial number. */
  readonly accessories = new Map<string, River3Accessory>();
  /** The Matter accessories this platform is currently serving, by serial number. */
  readonly matterAccessories = new Map<string, River3MatterAccessory>();
  /** Resolves when the Matter devices are registered and receiving state. */
  matterReady: Promise<void> = Promise.resolve();
  private transport?: Transport;

  constructor(
    readonly log: Logging,
    private readonly config: PlatformConfig,
    readonly api: API,
  ) {
    api.on('didFinishLaunching', () => this.launch());
    api.on('shutdown', () => this.shutdown());
  }

  /** Homebridge hands back HomeKit accessories it remembered from the last run. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  /** Homebridge hands back Matter accessories it remembered from the last run. */
  configureMatterAccessory(accessory: MatterAccessory): void {
    this.cachedMatter.set(accessory.UUID, accessory);
  }

  /** The Matter API if this bridge has Matter switched on. Older Homebridge versions have neither member. */
  private matterApi(): MatterAPI | undefined {
    const api = this.api as API & { isMatterEnabled?: () => boolean };
    return typeof api.isMatterEnabled === 'function' && api.isMatterEnabled() ? api.matter : undefined;
  }

  /** Decide between Matter and HomeKit for this run. */
  private chooseMatter(): MatterAPI | undefined {
    const protocol = readProtocol(this.config.protocol);
    const matter = this.matterApi();
    if (protocol === 'homekit') {
      return undefined;
    }
    if (protocol === 'matter' && !matter) {
      this.log.warn(
        'Matter was asked for, but it is not switched on for this bridge (it needs Homebridge 2.3 or later). Using HomeKit instead.',
      );
    }
    return matter;
  }

  private launch(): void {
    const deviceConfigs = this.readDevices();
    const transport = deviceConfigs.length > 0 ? this.createTransport() : undefined;
    const matter = this.chooseMatter();
    // Only tidy up remembered accessories when the settings are usable, so a
    // missing password does not wipe the user's rooms and automations.
    const settled = transport !== undefined || deviceConfigs.length === 0;

    const wantedHap = new Set<string>();
    const wantedMatter = new Set<string>();
    const matterToRegister: MatterAccessory[] = [];

    if (transport) {
      this.transport = transport;
      if (matter) {
        this.log.info('Using Matter, so Apple Home can show power in watts. Pair with the bridge\'s Matter code.');
      }
      for (const deviceConfig of deviceConfigs) {
        const device = new River3Device(deviceConfig.serialNumber, transport, this.log);
        this.devices.push(device);
        if (matter) {
          const accessory = new River3MatterAccessory(this.api, matter, this.log, device, deviceConfig);
          const built = accessory.build();
          if (built.length === 0) {
            this.log.warn(`${deviceConfig.name} has every feature switched off in the settings, so there is nothing to show.`);
          }
          for (const item of built) {
            wantedMatter.add(item.UUID);
          }
          matterToRegister.push(...built);
          this.matterAccessories.set(deviceConfig.serialNumber, accessory);
        } else {
          const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${deviceConfig.serialNumber}`);
          wantedHap.add(uuid);
          let accessory = this.cached.get(uuid);
          if (accessory) {
            accessory.displayName = deviceConfig.name;
          } else {
            accessory = new this.api.platformAccessory(deviceConfig.name, uuid);
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.log.info(`Added ${deviceConfig.name} (${deviceConfig.serialNumber})`);
          }
          this.accessories.set(deviceConfig.serialNumber, new River3Accessory(this, accessory, device, deviceConfig));
        }
        device.start();
      }
      transport.start();
    }

    if (settled) {
      const stale = [...this.cached.values()].filter((accessory) => !wantedHap.has(accessory.UUID));
      if (stale.length > 0) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
        for (const accessory of stale) {
          this.log.info(`Removed ${accessory.displayName} from HomeKit, which is no longer wanted there`);
        }
      }
    }

    const matterApi = matter ?? this.matterApi();
    if (matterApi) {
      this.matterReady = this.syncMatter(matterApi, matterToRegister, wantedMatter, settled);
    }
  }

  private async syncMatter(
    matter: MatterAPI,
    toRegister: MatterAccessory[],
    wanted: Set<string>,
    settled: boolean,
  ): Promise<void> {
    try {
      if (settled) {
        const stale = [...this.cachedMatter.values()].filter((accessory) => !wanted.has(accessory.UUID));
        if (stale.length > 0) {
          await matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
          for (const accessory of stale) {
            this.log.info(`Removed ${accessory.displayName} from Matter, which is no longer wanted there`);
          }
        }
      }
      if (toRegister.length > 0) {
        // Matter accessories must be registered on every start, including remembered ones.
        await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRegister);
        for (const accessory of this.matterAccessories.values()) {
          accessory.start();
        }
      }
    } catch (error) {
      this.log.error(`Could not set up the Matter accessories: ${(error as Error).message}`);
    }
  }

  private readDevices(): DeviceConfig[] {
    const list = Array.isArray(this.config.devices) ? (this.config.devices as unknown[]) : [];
    const seen = new Set<string>();
    const devices: DeviceConfig[] = [];
    for (const raw of list) {
      const deviceConfig = readDeviceConfig(raw);
      if (!deviceConfig) {
        this.log.warn('Skipping a device with no serial number in the plugin settings');
        continue;
      }
      if (seen.has(deviceConfig.serialNumber)) {
        this.log.warn(`Skipping a second entry for ${deviceConfig.serialNumber}`);
        continue;
      }
      seen.add(deviceConfig.serialNumber);
      if (!(deviceConfig.serialNumber.slice(0, 4) in KNOWN_SERIAL_PREFIXES)) {
        this.log.warn(
          `${deviceConfig.serialNumber} does not look like a RIVER 3 or RIVER 3 Plus serial number. Trying it anyway.`,
        );
      }
      devices.push(deviceConfig);
    }
    if (devices.length === 0) {
      this.log.warn('No devices are set up. Add your RIVER 3 serial number in the plugin settings.');
    }
    return devices;
  }

  private createTransport(): Transport | undefined {
    if (this.config.simulate === true) {
      this.log.warn('Simulation is on: showing a pretend RIVER 3, not your real one.');
      return new SimulatorTransport();
    }
    const email = typeof this.config.email === 'string' ? this.config.email.trim() : '';
    const password = typeof this.config.password === 'string' ? this.config.password : '';
    if (!email || !password) {
      this.log.error('Add your EcoFlow app email and password in the plugin settings, then restart Homebridge.');
      return undefined;
    }
    const apiHost =
      typeof this.config.apiHost === 'string' && this.config.apiHost.trim() ? this.config.apiHost.trim() : DEFAULT_API_HOST;
    return new CloudTransport({ email, password, apiHost }, this.log);
  }

  private shutdown(): void {
    for (const device of this.devices) {
      device.stop();
    }
    this.transport?.stop();
  }
}
