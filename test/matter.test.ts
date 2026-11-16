import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import type { API, Logging, MatterAccessory, PlatformAccessory, PlatformConfig } from 'homebridge';

import { River3Device } from '../src/ecoflow/device.js';
import { encode } from '../src/ecoflow/protocol.js';
import { matterUuid, River3MatterAccessory } from '../src/matterAccessory.js';
import { River3Platform } from '../src/platform.js';
import { PLATFORM_NAME, readDeviceConfig } from '../src/settings.js';
import { FakeTransport, recordingLog } from './helpers.js';

const apiModule = (await import(
  pathToFileURL(join(process.cwd(), 'node_modules', 'homebridge', 'dist', 'api.js')).href
)) as { HomebridgeAPI: new () => API & { signalFinished(): void; signalShutdown(): void } };

const SN = 'R631TEST0001';
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class Failure extends Error {}

/** A stand-in for Homebridge's Matter API that records what the plugin does with it. */
function fakeMatter() {
  const registered: MatterAccessory[] = [];
  const unregistered: MatterAccessory[] = [];
  const updates: Array<{ uuid: string; cluster: string; attributes: Record<string, unknown> }> = [];
  const control = { failUpdates: false };
  const matter = {
    deviceTypes: { OnOffOutlet: 'outlet', DimmableLight: 'light', ContactSensor: 'contact', ElectricalSensor: 'electrical-sensor' },
    status: { Failure },
    registerPlatformAccessories: async (_plugin: string, _platform: string, accessories: MatterAccessory[]) => {
      registered.push(...accessories);
    },
    unregisterPlatformAccessories: async (_plugin: string, _platform: string, accessories: MatterAccessory[]) => {
      unregistered.push(...accessories);
    },
    updateAccessoryState: async (uuid: string, cluster: string, attributes: Record<string, unknown>) => {
      if (control.failUpdates) {
        throw new Error('not ready');
      }
      updates.push({ uuid, cluster, attributes });
    },
  };
  /** The most recent value sent for one cluster of one device. */
  const latest = (uuid: string, cluster: string) =>
    updates.filter((u) => u.uuid === uuid && u.cluster === cluster).at(-1)?.attributes;
  return { matter, registered, unregistered, updates, control, latest };
}

const running: Array<{ signalShutdown(): void }> = [];
after(() => running.forEach((api) => api.signalShutdown()));

function launch(
  config: Record<string, unknown>,
  options: { matter?: ReturnType<typeof fakeMatter>; cachedHap?: PlatformAccessory[]; cachedMatter?: MatterAccessory[] } = {},
) {
  const api = new apiModule.HomebridgeAPI();
  running.push(api);
  const log = recordingLog();
  const hapRegistered: PlatformAccessory[] = [];
  const hapUnregistered: PlatformAccessory[] = [];
  api.registerPlatformAccessories = (_p, _n, accessories) => void hapRegistered.push(...accessories);
  api.unregisterPlatformAccessories = (_p, _n, accessories) => void hapUnregistered.push(...accessories);
  Object.defineProperty(api, 'isMatterEnabled', { value: () => options.matter !== undefined });
  Object.defineProperty(api, 'matter', { value: options.matter?.matter });
  const platform = new River3Platform(
    log as unknown as Logging,
    { platform: PLATFORM_NAME, name: 'EcoFlow', simulate: true, ...config } as PlatformConfig,
    api,
  );
  options.cachedHap?.forEach((accessory) => platform.configureAccessory(accessory));
  options.cachedMatter?.forEach((accessory) => platform.configureMatterAccessory(accessory));
  api.signalFinished();
  return { api, log, platform, hapRegistered, hapUnregistered };
}

const devices = (device: Record<string, unknown> = {}) => ({ devices: [{ name: 'River', serialNumber: SN, ...device }] });

describe('Matter', () => {
  it('is used automatically when the bridge has Matter switched on', async () => {
    const fake = fakeMatter();
    const { api, platform, hapRegistered, log } = launch(devices(), { matter: fake });
    await platform.matterReady;

    assert.equal(hapRegistered.length, 0);
    assert.equal(platform.accessories.size, 0);
    assert.ok(log.has('info', 'Using Matter'));
    assert.deepEqual(
      fake.registered.map((a) => [a.displayName, a.deviceType]),
      [
        ['River AC Outlets', 'outlet'],
        ['River 12V Outlet', 'outlet'],
        ['River Input Power', 'electrical-sensor'],
        ['River Output Power', 'electrical-sensor'],
        ['River USB-A Power', 'electrical-sensor'],
        ['River USB-C Power', 'electrical-sensor'],
        ['River Light', 'light'],
        ['River Mains Power', 'contact'],
      ],
    );
    const ac = fake.registered[0]!;
    assert.equal(ac.UUID, matterUuid(api, SN, 'ac'));
    assert.equal(ac.manufacturer, 'EcoFlow');
    assert.equal(ac.model, 'RIVER 3 Plus');
    assert.equal(new Set(fake.registered.map((a) => a.UUID)).size, 8);
    assert.equal(new Set(fake.registered.map((a) => a.serialNumber)).size, 8);
  });

  it('declares power, energy and the battery so Homebridge composes the right Matter features', async () => {
    const fake = fakeMatter();
    const { platform } = launch(devices(), { matter: fake });
    await platform.matterReady;
    const [ac, dc, input, output, usbA, usbC, light, mains] = fake.registered as [
      MatterAccessory, MatterAccessory, MatterAccessory, MatterAccessory, MatterAccessory, MatterAccessory, MatterAccessory, MatterAccessory,
    ];

    assert.equal(ac.clusters?.electricalPowerMeasurement?.powerMode, 2);
    assert.equal(dc.clusters?.electricalPowerMeasurement?.powerMode, 1);
    assert.ok('cumulativeEnergyImported' in (ac.clusters?.electricalEnergyMeasurement ?? {}));
    assert.ok('cumulativeEnergyImported' in (dc.clusters?.electricalEnergyMeasurement ?? {}));
    // The battery rides on the first device only.
    assert.ok(ac.clusters?.powerSource);
    assert.equal(dc.clusters?.powerSource, undefined);
    assert.equal(input.clusters?.electricalPowerMeasurement?.powerMode, 0);
    assert.equal(output.clusters?.electricalPowerMeasurement?.powerMode, 0);
    assert.equal(usbA.clusters?.electricalPowerMeasurement?.powerMode, 1);
    assert.equal(usbC.clusters?.electricalPowerMeasurement?.powerMode, 1);
    assert.equal(ac.clusters?.powerSource?.description, 'Battery');
    assert.equal(ac.clusters?.powerSource?.batFunctionalWhileCharging, true);
    assert.deepEqual(light.clusters?.levelControl, { currentLevel: 254, minLevel: 1, maxLevel: 254 });
    assert.deepEqual(Object.keys(mains.clusters ?? {}), ['booleanState']);
    assert.equal(mains.handlers, undefined);
  });

  it('reports watts in milliwatts and the battery in half-percent steps', async () => {
    const fake = fakeMatter();
    const { api, platform } = launch(devices(), { matter: fake });
    await platform.matterReady;
    const ac = matterUuid(api, SN, 'ac');

    // The simulator starts at 76%, charging, with 58 W on the AC outlets.
    assert.deepEqual(fake.latest(ac, 'electricalPowerMeasurement'), { activePower: 58_000 });
    assert.deepEqual(fake.latest(ac, 'onOff'), { onOff: true });
    assert.deepEqual(fake.latest(ac, 'powerSource'), { batPercentRemaining: 152, batChargeLevel: 0, batChargeState: 1 });
    assert.deepEqual(fake.latest(matterUuid(api, SN, 'dc'), 'electricalPowerMeasurement'), { activePower: 0 });
    assert.deepEqual(fake.latest(matterUuid(api, SN, 'input'), 'electricalPowerMeasurement'), { activePower: 158_000 });
    assert.deepEqual(fake.latest(matterUuid(api, SN, 'output'), 'electricalPowerMeasurement'), { activePower: 58_000 });
    assert.deepEqual(fake.latest(matterUuid(api, SN, 'usbA'), 'electricalPowerMeasurement'), { activePower: 0 });
    assert.deepEqual(fake.latest(matterUuid(api, SN, 'usbC'), 'electricalPowerMeasurement'), { activePower: 0 });
    assert.deepEqual(fake.latest(matterUuid(api, SN, 'mains'), 'booleanState'), { stateValue: true });
  });

  it('switches an outlet from Matter and reports the drop in power', async () => {
    const fake = fakeMatter();
    const { api, platform } = launch(devices(), { matter: fake });
    await platform.matterReady;
    const ac = fake.registered[0]!;

    await ac.handlers!.onOff!.off!(undefined);
    await wait(350);
    assert.deepEqual(fake.latest(matterUuid(api, SN, 'ac'), 'onOff'), { onOff: false });
    assert.deepEqual(fake.latest(matterUuid(api, SN, 'ac'), 'electricalPowerMeasurement'), { activePower: 0 });

    await fake.registered[1]!.handlers!.onOff!.on!(undefined);
    await wait(350);
    assert.deepEqual(fake.latest(matterUuid(api, SN, 'dc'), 'onOff'), { onOff: true });
    assert.deepEqual(fake.latest(matterUuid(api, SN, 'dc'), 'electricalPowerMeasurement'), { activePower: 12_000 });
  });

  it('maps the light level to off, dim and bright', async () => {
    const fake = fakeMatter();
    const { api, platform } = launch(devices(), { matter: fake });
    await platform.matterReady;
    const light = fake.registered[6]!;
    const uuid = matterUuid(api, SN, 'light');

    await light.handlers!.onOff!.on!(undefined);
    await wait(350);
    assert.deepEqual(fake.latest(uuid, 'onOff'), { onOff: true });
    assert.deepEqual(fake.latest(uuid, 'levelControl'), { currentLevel: 254 });

    await light.handlers!.levelControl!.moveToLevel!({ level: 60 } as never);
    await wait(350);
    assert.deepEqual(fake.latest(uuid, 'levelControl'), { currentLevel: 127 });

    await light.handlers!.onOff!.off!(undefined);
    await wait(350);
    assert.deepEqual(fake.latest(uuid, 'onOff'), { onOff: false });
  });

  it('marks the battery low, and opens the mains sensor in a power cut', async () => {
    const fake = fakeMatter();
    const { api, platform } = launch(devices({ lowBatteryThreshold: 80 }), { matter: fake });
    await platform.matterReady;
    assert.equal(fake.latest(matterUuid(api, SN, 'ac'), 'powerSource')?.batChargeLevel, 1);

    const simulator = (platform as unknown as { transport: { setMains(sn: string, on: boolean): void } }).transport;
    simulator.setMains(SN, false);
    assert.deepEqual(fake.latest(matterUuid(api, SN, 'mains'), 'booleanState'), { stateValue: false });
    assert.equal(fake.latest(matterUuid(api, SN, 'ac'), 'powerSource')?.batChargeState, 3);
  });

  it('fails a command with a Matter error while the unit is unreachable', async () => {
    const fake = fakeMatter();
    const { platform, log } = launch(devices(), { matter: fake });
    await platform.matterReady;
    (platform as unknown as { transport: { stop(): void } }).transport.stop();
    assert.throws(() => fake.registered[0]!.handlers!.onOff!.off!(undefined), Failure);
    assert.ok(log.has('warn', 'is offline'));
  });

  it('puts the battery on the next device when the AC outlets are hidden', async () => {
    const fake = fakeMatter();
    const { platform } = launch(devices({ acOutlet: false, xboostSwitch: true }), { matter: fake });
    await platform.matterReady;
    assert.deepEqual(
      fake.registered.map((a) => a.displayName),
      ['River 12V Outlet', 'River Input Power', 'River Output Power', 'River USB-A Power', 'River USB-C Power', 'River Light', 'River Mains Power', 'River X-Boost'],
    );
    assert.ok(fake.registered[0]!.clusters?.powerSource);
    assert.equal(fake.registered[7]!.clusters?.electricalPowerMeasurement, undefined);
  });

  it('removes remembered HomeKit accessories when it moves to Matter', async () => {
    const before = launch(devices());
    assert.equal(before.hapRegistered.length, 1);

    const fake = fakeMatter();
    const { platform, hapUnregistered } = launch(devices(), { matter: fake, cachedHap: before.hapRegistered });
    await platform.matterReady;
    assert.deepEqual(hapUnregistered, before.hapRegistered);
    assert.equal(fake.registered.length, 8);
  });

  it('stays on HomeKit when told to, and removes remembered Matter devices', async () => {
    const first = fakeMatter();
    const earlier = launch(devices(), { matter: first });
    await earlier.platform.matterReady;

    const fake = fakeMatter();
    const { platform, hapRegistered } = launch(
      { protocol: 'homekit', ...devices() },
      { matter: fake, cachedMatter: first.registered },
    );
    await platform.matterReady;
    assert.equal(hapRegistered.length, 1);
    assert.equal(fake.registered.length, 0);
    assert.deepEqual(fake.unregistered, first.registered);
  });

  it('removes a remembered Matter device that was switched off in the settings', async () => {
    const first = fakeMatter();
    const earlier = launch(devices({ xboostSwitch: true }), { matter: first });
    await earlier.platform.matterReady;

    const fake = fakeMatter();
    const { platform } = launch(devices(), { matter: fake, cachedMatter: first.registered });
    await platform.matterReady;
    assert.deepEqual(
      fake.unregistered.map((a) => a.displayName),
      ['River X-Boost'],
    );
    assert.equal(fake.registered.length, 8);
  });

  it('falls back to HomeKit, with a warning, when Matter is asked for but unavailable', () => {
    const { log, hapRegistered } = launch({ protocol: 'matter', ...devices() });
    assert.ok(log.has('warn', 'Matter was asked for'));
    assert.equal(hapRegistered.length, 1);
  });

  it('keeps remembered Matter devices when the credentials are missing', async () => {
    const first = fakeMatter();
    const earlier = launch(devices(), { matter: first });
    await earlier.platform.matterReady;

    const fake = fakeMatter();
    const { platform, log } = launch({ simulate: false, ...devices() }, { matter: fake, cachedMatter: first.registered });
    await platform.matterReady;
    assert.ok(log.has('error', 'Add your EcoFlow app email and password'));
    assert.equal(fake.unregistered.length, 0);
    assert.equal(fake.registered.length, 0);
  });
});

describe('Matter energy totals', () => {
  function setup() {
    const fake = fakeMatter();
    const api = new apiModule.HomebridgeAPI();
    const transport = new FakeTransport();
    const log = recordingLog();
    const clock = { now: 1_000_000 };
    const device = new River3Device(SN, transport, log, undefined, () => clock.now);
    const accessory = new River3MatterAccessory(
      api,
      fake.matter as unknown as NonNullable<API['matter']>,
      log as unknown as Logging,
      device,
      readDeviceConfig({ name: 'River', serialNumber: SN })!,
      () => clock.now,
    );
    device.start();
    transport.goOnline();
    const report = (acEnergyWh: number, soc = 50) =>
      transport.deliver(
        SN,
        'data',
        encode.envelope([
          {
            cmdFunc: 254,
            cmdId: 21,
            pdata: encode.display({
              cms_batt_soc: soc,
              display_statistics_sum: { list_info: [{ statistics_object: 2, statistics_content: acEnergyWh }] },
            }),
          },
        ]),
      );
    after(() => device.stop());
    return { fake, api, accessory, clock, report };
  }

  it('sends energy in milliwatt-hours, at most once a minute', () => {
    const { fake, api, accessory, clock, report } = setup();
    const ac = matterUuid(api, SN, 'ac');
    report(1200);
    accessory.build();
    accessory.start();
    assert.deepEqual(fake.latest(ac, 'electricalEnergyMeasurement'), { cumulativeEnergyImported: { energy: 1_200_000 } });

    clock.now += 30_000;
    report(1201, 51);
    assert.deepEqual(fake.latest(ac, 'electricalEnergyMeasurement'), { cumulativeEnergyImported: { energy: 1_200_000 } });
    assert.equal(fake.latest(ac, 'powerSource')?.batPercentRemaining, 102);

    clock.now += 30_000;
    report(1202, 52);
    assert.deepEqual(fake.latest(ac, 'electricalEnergyMeasurement'), { cumulativeEnergyImported: { energy: 1_202_000 } });
  });

  it('starts with a blank energy total until the unit reports one', () => {
    const { accessory } = setup();
    const [ac] = accessory.build();
    assert.deepEqual(ac!.clusters?.electricalEnergyMeasurement, { cumulativeEnergyImported: null });
  });

  it('does not resend values that have not changed, and retries one that failed', async () => {
    const { fake, api, accessory, report } = setup();
    const ac = matterUuid(api, SN, 'ac');
    report(1200);
    accessory.build();
    fake.control.failUpdates = true;
    accessory.start();
    await wait(10);
    assert.equal(fake.updates.length, 0);

    fake.control.failUpdates = false;
    report(1200, 49);
    assert.equal(fake.latest(ac, 'powerSource')?.batPercentRemaining, 98);
    assert.deepEqual(fake.latest(ac, 'onOff'), { onOff: false });
    const count = fake.updates.length;

    report(1200, 49);
    assert.equal(fake.updates.length, count);
  });
});
