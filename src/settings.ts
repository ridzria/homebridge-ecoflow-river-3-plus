export const PLATFORM_NAME = 'EcoFlowRiver3';
export const PLUGIN_NAME = 'homebridge-ecoflow-river3';

export const DEFAULT_API_HOST = 'api.ecoflow.com';

/** Serial number prefixes of the units this plugin understands. */
export const KNOWN_SERIAL_PREFIXES: Record<string, string> = {
  R631: 'RIVER 3 Plus',
  R634: 'RIVER 3 Plus (270)',
  R635: 'RIVER 3 Plus Wireless',
  R651: 'RIVER 3',
  R653: 'RIVER 3',
  R654: 'RIVER 3',
  R655: 'RIVER 3',
};

/** How the unit is presented: "auto" uses Matter when the bridge has it switched on, HomeKit otherwise. */
export type Protocol = 'auto' | 'homekit' | 'matter';

export function readProtocol(raw: unknown): Protocol {
  return raw === 'homekit' || raw === 'matter' ? raw : 'auto';
}

export interface DeviceConfig {
  name: string;
  serialNumber: string;
  acOutlet: boolean;
  dcOutlet: boolean;
  xboostSwitch: boolean;
  light: boolean;
  mainsSensor: boolean;
  lowBatteryThreshold: number;
}

/** Fill in defaults and tidy up one entry of the "devices" list. Returns undefined if it is unusable. */
export function readDeviceConfig(raw: unknown): DeviceConfig | undefined {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const entry = raw as Record<string, unknown>;
  const serialNumber = typeof entry.serialNumber === 'string' ? entry.serialNumber.trim().toUpperCase() : '';
  if (!serialNumber) {
    return undefined;
  }
  const flag = (key: string, fallback: boolean) => (typeof entry[key] === 'boolean' ? (entry[key] as boolean) : fallback);
  const threshold = Number(entry.lowBatteryThreshold);
  const plus = serialNumber.startsWith('R63');
  return {
    name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : 'RIVER 3',
    serialNumber,
    acOutlet: flag('acOutlet', true),
    dcOutlet: flag('dcOutlet', true),
    xboostSwitch: flag('xboostSwitch', false),
    // Only the Plus models have the light bar.
    light: flag('light', plus),
    mainsSensor: flag('mainsSensor', true),
    lowBatteryThreshold: Number.isFinite(threshold) && threshold >= 0 && threshold <= 100 ? threshold : 20,
  };
}
