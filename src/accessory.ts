import type { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';

import { DeviceOfflineError, LED_MODE, type ControlName, type River3Device } from './ecoflow/device.js';
import type { River3Platform } from './platform.js';
import { KNOWN_SERIAL_PREFIXES, type DeviceConfig } from './settings.js';

/** Eve's "Consumption" characteristic, so apps such as Eve and Controller can show watts. */
const EVE_CONSUMPTION_UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';
const BATTERY_HEALTH_UUID = 'C7A5B4D1-7C5E-4F7A-9E31-7E6B1B7A0001';
const BATTERY_CYCLES_UUID = 'C7A5B4D1-7C5E-4F7A-9E31-7E6B1B7A0002';
const CHARGE_REMAINING_UUID = 'C7A5B4D1-7C5E-4F7A-9E31-7E6B1B7A0003';
const DISCHARGE_REMAINING_UUID = 'C7A5B4D1-7C5E-4F7A-9E31-7E6B1B7A0004';

type ServiceType = WithUUID<typeof Service>;

/** Presents one RIVER 3 unit to HomeKit. */
export class River3Accessory {
  private readonly battery: Service;
  private readonly batteryTemperature: Service;
  private readonly acOutlet?: Service;
  private readonly dcOutlet?: Service;
  private readonly xboost?: Service;
  private readonly light?: Service;
  private readonly mains?: Service;
  private readonly acWatts?: Characteristic;
  private readonly dcWatts?: Characteristic;
  private readonly batteryHealth?: Characteristic;
  private readonly batteryCycles?: Characteristic;
  private readonly chargeRemaining?: Characteristic;
  private readonly dischargeRemaining?: Characteristic;
  private readonly pvInputPower?: Characteristic;

  constructor(
    private readonly platform: River3Platform,
    private readonly accessory: PlatformAccessory,
    private readonly device: River3Device,
    private readonly config: DeviceConfig,
  ) {
    const { Service, Characteristic } = platform.api.hap;

    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'EcoFlow')
      .setCharacteristic(Characteristic.Model, KNOWN_SERIAL_PREFIXES[config.serialNumber.slice(0, 4)] ?? 'RIVER 3')
      .setCharacteristic(Characteristic.SerialNumber, config.serialNumber);

    this.battery = this.service(Service.Battery, 'battery', 'Battery', true)!;
    this.battery.getCharacteristic(Characteristic.BatteryLevel).onGet(() => this.read(() => this.device.batteryLevel ?? 0));
    this.battery
      .getCharacteristic(Characteristic.ChargingState)
      .onGet(() => this.read(() => this.chargingState()));
    this.battery
      .getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() => this.read(() => this.lowBattery()));
    this.batteryHealth = this.customBatteryCharacteristic('Battery Health', BATTERY_HEALTH_UUID, 0, 100, 1);
    this.batteryHealth.onGet(() => this.read(() => this.device.batteryHealthPercent ?? 0));
    this.batteryCycles = this.customBatteryCharacteristic('Battery Cycles', BATTERY_CYCLES_UUID, 0, 100_000, 1);
    this.batteryCycles.onGet(() => this.read(() => this.device.batteryCycles ?? 0));
    this.chargeRemaining = this.customBatteryCharacteristic('Charge Remaining', CHARGE_REMAINING_UUID, 0, 65_535, 1, 'min');
    this.chargeRemaining.onGet(() => this.read(() => this.device.chargeRemainingMinutes ?? 0));
    this.dischargeRemaining = this.customBatteryCharacteristic('Discharge Remaining', DISCHARGE_REMAINING_UUID, 0, 65_535, 1, 'min');
    this.dischargeRemaining.onGet(() => this.read(() => this.device.dischargeRemainingMinutes ?? 0));
    // Use Eve's known Consumption schema so legacy HomeKit controllers render a number.
    this.pvInputPower = this.customBatteryCharacteristic('PV Input Power', EVE_CONSUMPTION_UUID, 0, 3_000, 0.1, 'W', this.platform.api.hap.Formats.FLOAT);
    this.pvInputPower.onGet(() => this.read(() => this.device.pvInputWatts));

    this.batteryTemperature = this.service(Service.TemperatureSensor, 'battery-temperature', 'Battery Temperature', true)!;
    this.batteryTemperature
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.read(() => this.device.batteryTemperatureC ?? 0));

    this.acOutlet = this.service(Service.Outlet, 'ac', 'AC Outlets', config.acOutlet);
    if (this.acOutlet) {
      this.bindSwitch(this.acOutlet, 'acOutput');
      this.acOutlet
        .getCharacteristic(Characteristic.OutletInUse)
        .onGet(() => this.read(() => this.device.acOutputWatts > 0));
      this.acWatts = this.wattsCharacteristic(this.acOutlet);
      this.acWatts.onGet(() => this.read(() => this.device.acOutputWatts));
    }

    this.dcOutlet = this.service(Service.Outlet, 'dc', '12V Outlet', config.dcOutlet);
    if (this.dcOutlet) {
      this.bindSwitch(this.dcOutlet, 'dcOutput');
      this.dcOutlet
        .getCharacteristic(Characteristic.OutletInUse)
        .onGet(() => this.read(() => this.device.dcOutputWatts > 0));
      this.dcWatts = this.wattsCharacteristic(this.dcOutlet);
      this.dcWatts.onGet(() => this.read(() => this.device.dcOutputWatts));
    }

    this.xboost = this.service(Service.Switch, 'xboost', 'X-Boost', config.xboostSwitch);
    if (this.xboost) {
      this.bindSwitch(this.xboost, 'xboost');
    }

    this.light = this.service(Service.Lightbulb, 'light', 'Light', config.light);
    if (this.light) {
      this.light
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.read(() => this.device.ledMode !== LED_MODE.off))
        .onSet((value) => {
          if (!value) {
            this.write('ledMode', LED_MODE.off);
          } else if (this.device.ledMode === LED_MODE.off) {
            this.write('ledMode', LED_MODE.bright);
          }
        });
      this.light
        .getCharacteristic(Characteristic.Brightness)
        .onGet(() => this.read(() => this.brightness()))
        .onSet((value) => {
          const percent = Number(value);
          this.write('ledMode', percent <= 0 ? LED_MODE.off : percent <= 50 ? LED_MODE.dim : LED_MODE.bright);
        });
    }

    this.mains = this.service(Service.ContactSensor, 'mains', 'Mains Power', config.mainsSensor);
    if (this.mains) {
      this.mains
        .getCharacteristic(Characteristic.ContactSensorState)
        .onGet(() => this.read(() => this.mainsState()));
    }

    device.on('update', () => this.push());
    this.push();
  }

  /** Find, create or remove one of the accessory's services, depending on whether it is wanted. */
  private service(type: ServiceType, subtype: string, label: string, wanted: boolean): Service | undefined {
    const { Characteristic } = this.platform.api.hap;
    const existing = this.accessory.getServiceById(type, subtype);
    if (!wanted) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return undefined;
    }
    const name = `${this.config.name} ${label}`;
    const service = existing ?? this.accessory.addService(type, name, subtype);
    service.setCharacteristic(Characteristic.Name, name);
    // ConfiguredName is what the Home app shows when an accessory has several services.
    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(Characteristic.ConfiguredName);
      service.setCharacteristic(Characteristic.ConfiguredName, name);
    }
    return service;
  }

  private wattsCharacteristic(service: Service): Characteristic {
    const { Characteristic, Formats, Perms } = this.platform.api.hap;
    const existing = service.characteristics.find((c) => c.UUID === EVE_CONSUMPTION_UUID);
    if (existing) {
      return existing;
    }
    return service.addCharacteristic(
      new Characteristic('Consumption', EVE_CONSUMPTION_UUID, {
        format: Formats.FLOAT,
        unit: 'W',
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        minValue: 0,
        maxValue: 3000,
        minStep: 0.1,
      }),
    );
  }

  private customBatteryCharacteristic(
    name: string,
    uuid: string,
    minValue: number,
    maxValue: number,
    minStep: number,
    unit = name === 'Battery Health' ? '%' : 'cycles',
    format = this.platform.api.hap.Formats.UINT16,
  ): Characteristic {
    const { Characteristic, Formats, Perms } = this.platform.api.hap;
    const existing = this.battery.characteristics.find((c) => c.UUID === uuid);
    if (existing) {
      return existing;
    }
    return this.battery.addCharacteristic(
      new Characteristic(name, uuid, {
        format,
        unit,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        minValue,
        maxValue,
        minStep,
      }),
    );
  }

  private bindSwitch(service: Service, control: Exclude<ControlName, 'ledMode'>): void {
    service
      .getCharacteristic(this.platform.api.hap.Characteristic.On)
      .onGet(() => this.read(() => this.device.isOn(control)))
      .onSet((value) => this.write(control, value ? 1 : 0));
  }

  /** Answer a HomeKit read, or report "No Response" while the unit cannot be reached. */
  private read<T extends CharacteristicValue>(value: () => T): T {
    if (!this.device.online) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return value();
  }

  private write(control: ControlName, value: number): void {
    try {
      this.device.set(control, value);
    } catch (error) {
      if (error instanceof DeviceOfflineError) {
        this.platform.log.warn(`${this.config.name} is offline, so the change was not sent`);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      throw error;
    }
  }

  private chargingState(): number {
    const { ChargingState } = this.platform.api.hap.Characteristic;
    return this.device.charging ? ChargingState.CHARGING : ChargingState.NOT_CHARGING;
  }

  private lowBattery(): number {
    const { StatusLowBattery } = this.platform.api.hap.Characteristic;
    const level = this.device.batteryLevel;
    return level !== undefined && level <= this.config.lowBatteryThreshold
      ? StatusLowBattery.BATTERY_LEVEL_LOW
      : StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  private brightness(): number {
    switch (this.device.ledMode) {
      case LED_MODE.off:
        return 0;
      case LED_MODE.dim:
        return 50;
      default:
        return 100;
    }
  }

  private mainsState(): number {
    const { ContactSensorState } = this.platform.api.hap.Characteristic;
    // "Contact detected" means mains is present; the sensor opens when the power fails.
    return this.device.mainsConnected === false
      ? ContactSensorState.CONTACT_NOT_DETECTED
      : ContactSensorState.CONTACT_DETECTED;
  }

  /** Send the current state to HomeKit. While the unit is offline the last values stay as they are. */
  private push(): void {
    if (!this.device.online) {
      return;
    }
    const { Characteristic } = this.platform.api.hap;
    const level = this.device.batteryLevel;
    if (level !== undefined) {
      this.battery.updateCharacteristic(Characteristic.BatteryLevel, level);
    }
    this.battery.updateCharacteristic(Characteristic.ChargingState, this.chargingState());
    this.battery.updateCharacteristic(Characteristic.StatusLowBattery, this.lowBattery());
    const health = this.device.batteryHealthPercent;
    if (health !== undefined) {
      this.batteryHealth?.updateValue(health);
    }
    const cycles = this.device.batteryCycles;
    if (cycles !== undefined) {
      this.batteryCycles?.updateValue(cycles);
    }
    const chargeRemaining = this.device.chargeRemainingMinutes;
    if (chargeRemaining !== undefined) {
      this.chargeRemaining?.updateValue(chargeRemaining);
    }
    const dischargeRemaining = this.device.dischargeRemainingMinutes;
    if (dischargeRemaining !== undefined) {
      this.dischargeRemaining?.updateValue(dischargeRemaining);
    }
    this.pvInputPower?.updateValue(this.device.pvInputWatts);
    const temperature = this.device.batteryTemperatureC;
    if (temperature !== undefined) {
      this.batteryTemperature.updateCharacteristic(Characteristic.CurrentTemperature, temperature);
    }

    if (this.acOutlet) {
      this.acOutlet.updateCharacteristic(Characteristic.On, this.device.isOn('acOutput'));
      this.acOutlet.updateCharacteristic(Characteristic.OutletInUse, this.device.acOutputWatts > 0);
      this.acWatts?.updateValue(this.device.acOutputWatts);
    }
    if (this.dcOutlet) {
      this.dcOutlet.updateCharacteristic(Characteristic.On, this.device.isOn('dcOutput'));
      this.dcOutlet.updateCharacteristic(Characteristic.OutletInUse, this.device.dcOutputWatts > 0);
      this.dcWatts?.updateValue(this.device.dcOutputWatts);
    }
    this.xboost?.updateCharacteristic(Characteristic.On, this.device.isOn('xboost'));
    if (this.light) {
      this.light.updateCharacteristic(Characteristic.On, this.device.ledMode !== LED_MODE.off);
      if (this.device.ledMode !== LED_MODE.off) {
        this.light.updateCharacteristic(Characteristic.Brightness, this.brightness());
      }
    }
    this.mains?.updateCharacteristic(Characteristic.ContactSensorState, this.mainsState());
  }
}
