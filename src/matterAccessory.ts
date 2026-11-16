import type { API, Logging, MatterAccessory } from 'homebridge';

import { DeviceOfflineError, LED_MODE, type ControlName, type River3Device } from './ecoflow/device.js';
import { KNOWN_SERIAL_PREFIXES, PLUGIN_NAME, type DeviceConfig } from './settings.js';

type MatterAPI = NonNullable<API['matter']>;
type ClusterState = Record<string, unknown>;

/** The separate devices one RIVER 3 becomes in Matter. */
export type MatterKind = 'ac' | 'dc' | 'input' | 'output' | 'pv' | 'usbA' | 'usbC' | 'light' | 'mains' | 'xboost';

/** Matter enum values, written out so the plugin does not depend on matter.js at load time. */
const POWER_MODE = { dc: 1, ac: 2 } as const;
const POWER_SOURCE_STATUS_ACTIVE = 1;
const BAT_CHARGE_LEVEL = { ok: 0, warning: 1, critical: 2 } as const;
const BAT_CHARGE_STATE = { charging: 1, full: 2, notCharging: 3 } as const;
const BAT_NOT_REPLACEABLE = 1;

const MAX_LEVEL = 254;
/** Energy totals are pushed to every controller at once, so send them sparingly. */
const ENERGY_INTERVAL_MS = 60_000;
const CRITICAL_BATTERY_PERCENT = 5;

export function matterUuid(api: API, serialNumber: string, kind: MatterKind): string {
  return api.hap.uuid.generate(`${PLUGIN_NAME}:${serialNumber}:matter:${kind}`);
}

/**
 * Presents one RIVER 3 unit over Matter, which is what lets Apple Home show
 * watts. Each function of the unit is its own Matter device, and the battery
 * rides on the first of them.
 */
export class River3MatterAccessory {
  private readonly kinds: MatterKind[];
  private readonly batteryOn?: MatterKind;
  private readonly sent = new Map<string, string>();
  private lastEnergyAt = 0;
  private started = false;

  constructor(
    private readonly api: API,
    private readonly matter: MatterAPI,
    private readonly log: Logging,
    private readonly device: River3Device,
    private readonly config: DeviceConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.kinds = River3MatterAccessory.kindsFor(config);
    this.batteryOn = this.kinds[0];
  }

  static kindsFor(config: DeviceConfig): MatterKind[] {
    const kinds: MatterKind[] = [];
    if (config.acOutlet) {
      kinds.push('ac');
    }
    if (config.dcOutlet) {
      kinds.push('dc');
    }
    kinds.push('input', 'output', 'pv', 'usbA', 'usbC');
    if (config.light) {
      kinds.push('light');
    }
    if (config.mainsSensor) {
      kinds.push('mains');
    }
    if (config.xboostSwitch) {
      kinds.push('xboost');
    }
    return kinds;
  }

  /** The Matter devices to register, with their starting state and command handlers. */
  build(): MatterAccessory[] {
    const model = KNOWN_SERIAL_PREFIXES[this.config.serialNumber.slice(0, 4)] ?? 'RIVER 3';
    const labels: Record<MatterKind, string> = {
      ac: 'AC Outlets',
      dc: '12V Outlet',
      input: 'Input Power',
      output: 'Output Power',
      pv: 'PV Input Power',
      usbA: 'USB-A Power',
      usbC: 'USB-C Power',
      light: 'Light',
      mains: 'Mains Power',
      xboost: 'X-Boost',
    };
    const { deviceTypes } = this.matter;
    return this.kinds.map((kind) => {
      const accessory: MatterAccessory = {
        UUID: matterUuid(this.api, this.config.serialNumber, kind),
        displayName: `${this.config.name} ${labels[kind]}`,
        deviceType:
          kind === 'light'
            ? deviceTypes.DimmableLight
            : kind === 'mains'
              ? deviceTypes.ContactSensor
              : kind === 'input' || kind === 'output' || kind === 'pv' || kind === 'usbA' || kind === 'usbC'
                ? (deviceTypes as Record<string, unknown>).ElectricalSensor as typeof deviceTypes.OnOffOutlet
                : deviceTypes.OnOffOutlet,
        manufacturer: 'EcoFlow',
        model,
        serialNumber: `${this.config.serialNumber}-${kind}`,
        context: { serialNumber: this.config.serialNumber, kind },
        clusters: this.stateFor(kind, true),
      };
      const handlers = this.handlersFor(kind);
      if (handlers) {
        accessory.handlers = handlers;
      }
      return accessory;
    });
  }

  /** Call once the devices are registered: sends the current state and keeps it up to date. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.device.on('update', () => this.push());
    this.push();
  }

  private handlersFor(kind: MatterKind): MatterAccessory['handlers'] {
    switch (kind) {
      case 'ac':
        return { onOff: this.onOffHandlers('acOutput') };
      case 'dc':
        return { onOff: this.onOffHandlers('dcOutput') };
      case 'xboost':
        return { onOff: this.onOffHandlers('xboost') };
      case 'light': {
        const toLevel = (args: { level?: number | null } | undefined) => {
          const level = Number(args?.level ?? 0);
          this.write('ledMode', level <= 0 ? LED_MODE.off : level <= MAX_LEVEL / 2 ? LED_MODE.dim : LED_MODE.bright);
        };
        return {
          onOff: {
            on: () => {
              if (this.device.ledMode === LED_MODE.off) {
                this.write('ledMode', LED_MODE.bright);
              }
            },
            off: () => this.write('ledMode', LED_MODE.off),
          },
          levelControl: { moveToLevel: toLevel, moveToLevelWithOnOff: toLevel },
        };
      }
      default:
        return undefined;
    }
  }

  private onOffHandlers(control: Exclude<ControlName, 'ledMode'>) {
    return {
      on: () => this.write(control, 1),
      off: () => this.write(control, 0),
    };
  }

  private write(control: ControlName, value: number): void {
    try {
      this.device.set(control, value);
    } catch (error) {
      if (error instanceof DeviceOfflineError) {
        this.log.warn(`${this.config.name} is offline, so the change was not sent`);
        throw new this.matter.status.Failure(`${this.config.name} is offline`);
      }
      throw error;
    }
  }

  /**
   * The cluster state for one device. With `initial` set, every cluster is
   * included even where no reading exists yet, because Homebridge decides which
   * Matter features a device has from the state it is registered with.
   */
  private stateFor(kind: MatterKind, initial: boolean): Record<string, ClusterState> {
    const state: Record<string, ClusterState> = {};
    switch (kind) {
      case 'ac':
        state.onOff = { onOff: this.device.isOn('acOutput') };
        state.electricalPowerMeasurement = this.power(this.device.acOutputWatts, POWER_MODE.ac, initial);
        this.addEnergy(state, this.device.acOutputEnergyWh, initial);
        break;
      case 'dc':
        state.onOff = { onOff: this.device.isOn('dcOutput') };
        state.electricalPowerMeasurement = this.power(this.device.dcOutputWatts, POWER_MODE.dc, initial);
        this.addEnergy(state, this.device.dcOutputEnergyWh, initial);
        break;
      case 'input':
        state.electricalPowerMeasurement = this.power(this.device.inputWatts, 0, initial);
        break;
      case 'output':
        state.electricalPowerMeasurement = this.power(this.device.outputWatts, 0, initial);
        break;
      case 'pv':
        state.electricalPowerMeasurement = this.power(this.device.pvInputWatts, 1, initial);
        break;
      case 'usbA':
        state.electricalPowerMeasurement = this.power(this.device.usbAOutputWatts, 1, initial);
        break;
      case 'usbC':
        state.electricalPowerMeasurement = this.power(this.device.usbCOutputWatts, 1, initial);
        break;
      case 'xboost':
        state.onOff = { onOff: this.device.isOn('xboost') };
        break;
      case 'light': {
        const mode = this.device.ledMode;
        state.onOff = { onOff: mode !== LED_MODE.off };
        if (initial) {
          state.levelControl = { currentLevel: MAX_LEVEL, minLevel: 1, maxLevel: MAX_LEVEL };
        } else if (mode !== LED_MODE.off) {
          state.levelControl = { currentLevel: mode === LED_MODE.dim ? Math.round(MAX_LEVEL / 2) : MAX_LEVEL };
        }
        break;
      }
      case 'mains':
        // True means "contact": mains is present. It turns false in a power cut.
        state.booleanState = { stateValue: this.device.mainsConnected !== false };
        break;
    }
    if (kind === this.batteryOn) {
      state.powerSource = this.battery(initial);
    }
    return state;
  }

  private power(watts: number, powerMode: number, initial: boolean): ClusterState {
    const activePower = Math.round(watts * 1000);
    return initial ? { powerMode, activePower } : { activePower };
  }

  private addEnergy(state: Record<string, ClusterState>, wattHours: number | undefined, initial: boolean): void {
    if (initial) {
      state.electricalEnergyMeasurement = {
        cumulativeEnergyImported: wattHours === undefined ? null : { energy: Math.round(wattHours * 1000) },
      };
    } else if (wattHours !== undefined) {
      state.electricalEnergyMeasurement = { cumulativeEnergyImported: { energy: Math.round(wattHours * 1000) } };
    }
  }

  private battery(initial: boolean): ClusterState {
    const level = this.device.batteryLevel;
    const mains = this.device.mainsConnected === true;
    const state: ClusterState = {
      batPercentRemaining: level === undefined ? null : level * 2,
      batChargeLevel:
        level === undefined || level > this.config.lowBatteryThreshold
          ? BAT_CHARGE_LEVEL.ok
          : level <= CRITICAL_BATTERY_PERCENT
            ? BAT_CHARGE_LEVEL.critical
            : BAT_CHARGE_LEVEL.warning,
      batChargeState: this.device.charging
        ? BAT_CHARGE_STATE.charging
        : mains && level !== undefined && level >= 100
          ? BAT_CHARGE_STATE.full
          : BAT_CHARGE_STATE.notCharging,
    };
    if (initial) {
      Object.assign(state, {
        status: POWER_SOURCE_STATUS_ACTIVE,
        order: 0,
        description: 'Battery',
        batReplacementNeeded: false,
        batReplaceability: BAT_NOT_REPLACEABLE,
        batFunctionalWhileCharging: true,
      });
    }
    return state;
  }

  /** Send whatever has changed to Matter. While the unit is offline the last values stay as they are. */
  private push(): void {
    if (!this.device.online) {
      return;
    }
    const now = this.now();
    const energyDue = now - this.lastEnergyAt >= ENERGY_INTERVAL_MS;
    let energySent = false;
    for (const kind of this.kinds) {
      const uuid = matterUuid(this.api, this.config.serialNumber, kind);
      for (const [cluster, attributes] of Object.entries(this.stateFor(kind, false))) {
        if (cluster === 'electricalEnergyMeasurement' && !energyDue) {
          continue;
        }
        const key = `${kind}:${cluster}`;
        const encoded = JSON.stringify(attributes);
        if (this.sent.get(key) === encoded) {
          continue;
        }
        this.sent.set(key, encoded);
        energySent ||= cluster === 'electricalEnergyMeasurement';
        this.matter.updateAccessoryState(uuid, cluster, attributes).catch((error: unknown) => {
          // Forget the value so the next update tries again.
          this.sent.delete(key);
          this.log.debug(`Could not update ${this.config.name} ${kind} ${cluster}: ${(error as Error).message}`);
        });
      }
    }
    if (energySent) {
      this.lastEnergyAt = now;
    }
  }
}
