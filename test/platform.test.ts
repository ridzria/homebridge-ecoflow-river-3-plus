import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import type { API, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { River3Platform } from '../src/platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js';
import { recordingLog } from './helpers.js';

// Homebridge does not export its API class, so load it from the package's files.
const apiModule = (await import(
  pathToFileURL(join(process.cwd(), 'node_modules', 'homebridge', 'dist', 'api.js')).href
)) as { HomebridgeAPI: new () => API & { signalFinished(): void; signalShutdown(): void } };

const SN = 'R631TEST0001';
const EVE_CONSUMPTION_UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const running: Array<{ signalShutdown(): void }> = [];
after(() => running.forEach((api) => api.signalShutdown()));

function launch(config: Record<string, unknown>, cached: PlatformAccessory[] = []) {
  const api = new apiModule.HomebridgeAPI();
  running.push(api);
  const log = recordingLog();
  const registered: PlatformAccessory[] = [];
  const unregistered: PlatformAccessory[] = [];
  api.registerPlatformAccessories = (_plugin, _platform, accessories) => void registered.push(...accessories);
  api.unregisterPlatformAccessories = (_plugin, _platform, accessories) => void unregistered.push(...accessories);
  const platform = new River3Platform(
    log as unknown as Logging,
    { platform: PLATFORM_NAME, name: 'EcoFlow', ...config } as PlatformConfig,
    api,
  );
  for (const accessory of cached) {
    platform.configureAccessory(accessory);
  }
  api.signalFinished();
  return { api, log, platform, registered, unregistered };
}

function services(accessory: PlatformAccessory): Record<string, Service> {
  const found: Record<string, Service> = {};
  for (const service of accessory.services) {
    found[service.subtype ?? service.constructor.name] = service;
  }
  return found;
}

const simulated = (device: Record<string, unknown> = {}) => ({
  simulate: true,
  devices: [{ name: 'River', serialNumber: SN, ...device }],
});

describe('platform with a simulated RIVER 3 Plus', () => {
  it('creates one accessory with the expected services and live values', async () => {
    const { api, platform, registered } = launch(simulated({ xboostSwitch: true }));
    const { Characteristic } = api.hap;
    assert.equal(registered.length, 1);
    assert.equal(platform.accessories.size, 1);
    const accessory = registered[0]!;
    assert.equal(accessory.UUID, api.hap.uuid.generate(`${PLUGIN_NAME}:${SN}`));

    const found = services(accessory);
    assert.deepEqual(Object.keys(found).sort(), [
      'AccessoryInformation', 'ac', 'battery', 'battery-temperature', 'dc', 'light', 'mains', 'xboost',
    ]);

    const info = found.AccessoryInformation!;
    assert.equal(info.getCharacteristic(Characteristic.Manufacturer).value, 'EcoFlow');
    assert.equal(info.getCharacteristic(Characteristic.Model).value, 'RIVER 3 Plus');
    assert.equal(info.getCharacteristic(Characteristic.SerialNumber).value, SN);

    // The simulator starts at 76%, charging on mains, AC on, 12 V off.
    assert.equal(found.battery!.getCharacteristic(Characteristic.BatteryLevel).value, 76);
    assert.equal(found.battery!.characteristics.find((c) => c.displayName === 'Battery Health')?.value, 100);
    assert.equal(found.battery!.characteristics.find((c) => c.displayName === 'Battery Cycles')?.value, 1);
    assert.equal(found.battery!.characteristics.find((c) => c.displayName === 'Charge Remaining')?.value, 60);
    assert.equal(found.battery!.characteristics.find((c) => c.displayName === 'Discharge Remaining')?.value, 0);
    assert.equal(found.battery!.characteristics.find((c) => c.displayName === 'PV Input Power')?.value, 0);
    assert.equal(found.battery!.characteristics.find((c) => c.displayName === 'PV Energy')?.value, null);
    assert.equal(found['battery-temperature']!.getCharacteristic(Characteristic.CurrentTemperature).value, 27);
    assert.equal(
      found.battery!.getCharacteristic(Characteristic.ChargingState).value,
      Characteristic.ChargingState.CHARGING,
    );
    assert.equal(
      found.battery!.getCharacteristic(Characteristic.StatusLowBattery).value,
      Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    assert.equal(found.ac!.getCharacteristic(Characteristic.On).value, true);
    assert.equal(found.ac!.getCharacteristic(Characteristic.OutletInUse).value, true);
    assert.equal(found.ac!.characteristics.find((c) => c.UUID === EVE_CONSUMPTION_UUID)?.value, 58);
    assert.equal(found.dc!.getCharacteristic(Characteristic.On).value, false);
    assert.equal(found.dc!.getCharacteristic(Characteristic.OutletInUse).value, false);
    assert.equal(found.xboost!.getCharacteristic(Characteristic.On).value, false);
    assert.equal(found.light!.getCharacteristic(Characteristic.On).value, false);
    assert.equal(
      found.mains!.getCharacteristic(Characteristic.ContactSensorState).value,
      Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
    assert.equal(found.ac!.getCharacteristic(Characteristic.Name).value, 'River AC Outlets');
    assert.equal(found.ac!.getCharacteristic(Characteristic.ConfiguredName).value, 'River AC Outlets');

    // Reads go through the handlers too.
    assert.equal(await found.battery!.getCharacteristic(Characteristic.BatteryLevel).handleGetRequest(), 76);
    assert.equal(
      await found['battery-temperature']!.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest(),
      27,
    );
    assert.equal(await found.ac!.getCharacteristic(Characteristic.On).handleGetRequest(), true);
  });

  it('exposes AC and 12 V watts through the legacy HomeKit Consumption characteristic', () => {
    const { registered } = launch({ protocol: 'homekit', ...simulated() });
    const found = services(registered[0]!);
    assert.equal(found.ac!.characteristics.find((c) => c.UUID === EVE_CONSUMPTION_UUID)?.value, 58);
    assert.equal(found.dc!.characteristics.find((c) => c.UUID === EVE_CONSUMPTION_UUID)?.value, 0);
  });

  it('switches the AC and 12 V outputs from HomeKit and follows the unit\'s confirmation', async () => {
    const { api, registered } = launch(simulated());
    const { Characteristic } = api.hap;
    const found = services(registered[0]!);
    const ac = found.ac!.getCharacteristic(Characteristic.On);
    const dc = found.dc!.getCharacteristic(Characteristic.On);

    await ac.handleSetRequest(false);
    await dc.handleSetRequest(true);
    assert.equal(await ac.handleGetRequest(), false);
    assert.equal(await dc.handleGetRequest(), true);

    await wait(350);
    assert.equal(ac.value, false);
    assert.equal(found.ac!.getCharacteristic(Characteristic.OutletInUse).value, false);
    assert.equal(dc.value, true);
    assert.equal(found.dc!.getCharacteristic(Characteristic.OutletInUse).value, true);
    assert.equal(found.dc!.characteristics.find((c) => c.UUID === EVE_CONSUMPTION_UUID)?.value, 12);
  });

  it('drives the light bar from On and Brightness', async () => {
    const { api, registered } = launch(simulated());
    const { Characteristic } = api.hap;
    const light = services(registered[0]!).light!;
    const on = light.getCharacteristic(Characteristic.On);
    const brightness = light.getCharacteristic(Characteristic.Brightness);

    await on.handleSetRequest(true);
    await wait(350);
    assert.equal(on.value, true);
    assert.equal(brightness.value, 100);

    await brightness.handleSetRequest(30);
    await wait(350);
    assert.equal(on.value, true);
    assert.equal(brightness.value, 50);

    await on.handleSetRequest(false);
    await wait(350);
    assert.equal(on.value, false);
  });

  it('opens the mains sensor when the power fails', async () => {
    const { api, platform, registered } = launch(simulated());
    const { Characteristic } = api.hap;
    const found = services(registered[0]!);
    const simulator = (platform as unknown as { transport: { setMains(sn: string, on: boolean): void } }).transport;
    simulator.setMains(SN, false);
    assert.equal(
      found.mains!.getCharacteristic(Characteristic.ContactSensorState).value,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );
    assert.equal(
      found.battery!.getCharacteristic(Characteristic.ChargingState).value,
      Characteristic.ChargingState.NOT_CHARGING,
    );
  });

  it('flags a low battery at the configured threshold', () => {
    const { api, registered } = launch(simulated({ lowBatteryThreshold: 80 }));
    const { Characteristic } = api.hap;
    assert.equal(
      services(registered[0]!).battery!.getCharacteristic(Characteristic.StatusLowBattery).value,
      Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
  });

  it('answers "No Response" once the unit is unreachable', async () => {
    const { api, platform, registered } = launch(simulated());
    const { Characteristic } = api.hap;
    const found = services(registered[0]!);
    (platform as unknown as { transport: { stop(): void } }).transport.stop();

    await assert.rejects(
      found.battery!.getCharacteristic(Characteristic.BatteryLevel).handleGetRequest(),
      (error: unknown) => error === api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    await assert.rejects(
      found.ac!.getCharacteristic(Characteristic.On).handleSetRequest(false),
      (error: unknown) => error === api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  });

  it('leaves out the services that are switched off in the settings', () => {
    const { registered } = launch(simulated({ dcOutlet: false, light: false, mainsSensor: false }));
    assert.deepEqual(Object.keys(services(registered[0]!)).sort(), [
      'AccessoryInformation', 'ac', 'battery', 'battery-temperature',
    ]);
  });

  it('has no light on a plain RIVER 3 unless asked for', () => {
    const plain = launch({ simulate: true, devices: [{ name: 'River', serialNumber: 'R651TEST0001' }] });
    assert.equal('light' in services(plain.registered[0]!), false);
    const forced = launch({ simulate: true, devices: [{ name: 'River', serialNumber: 'R651TEST0001', light: true }] });
    assert.equal('light' in services(forced.registered[0]!), true);
  });

  it('reuses a remembered accessory and removes services that are no longer wanted', () => {
    const first = launch(simulated({ xboostSwitch: true }));
    const remembered = first.registered[0]!;
    assert.ok('xboost' in services(remembered));

    const second = launch(simulated({ xboostSwitch: false, name: 'Garage River' }), [remembered]);
    assert.equal(second.registered.length, 0);
    assert.equal(second.unregistered.length, 0);
    assert.equal('xboost' in services(remembered), false);
    assert.equal(remembered.displayName, 'Garage River');
  });

  it('removes a remembered accessory that is no longer in the settings', () => {
    const first = launch(simulated());
    const second = launch({ simulate: true, devices: [{ name: 'Other', serialNumber: 'R631OTHER001' }] }, [
      first.registered[0]!,
    ]);
    assert.deepEqual(second.unregistered, [first.registered[0]!]);
    assert.equal(second.registered.length, 1);
  });
});

describe('platform settings', () => {
  it('asks for credentials and keeps remembered accessories when they are missing', () => {
    const first = launch(simulated());
    const { log, registered, unregistered, platform } = launch({ devices: [{ serialNumber: SN }] }, [first.registered[0]!]);
    assert.ok(log.has('error', 'Add your EcoFlow app email and password'));
    assert.equal(registered.length, 0);
    assert.equal(unregistered.length, 0);
    assert.equal(platform.accessories.size, 0);
  });

  it('warns when no devices are set up', () => {
    const { log, registered } = launch({ simulate: true });
    assert.ok(log.has('warn', 'No devices are set up'));
    assert.equal(registered.length, 0);
  });

  it('skips broken and duplicate entries, and tidies serial numbers', () => {
    const { log, platform } = launch({
      simulate: true,
      devices: [{ name: 'No serial' }, null, { serialNumber: ' r631test0001 ' }, { serialNumber: 'R631TEST0001' }],
    });
    assert.deepEqual([...platform.accessories.keys()], ['R631TEST0001']);
    assert.ok(log.has('warn', 'no serial number'));
    assert.ok(log.has('warn', 'second entry'));
  });

  it('warns about an unfamiliar serial number but still tries it', () => {
    const { log, platform } = launch({ simulate: true, devices: [{ serialNumber: 'XXXX1234' }] });
    assert.ok(log.has('warn', 'does not look like a RIVER 3'));
    assert.equal(platform.accessories.size, 1);
  });
});
