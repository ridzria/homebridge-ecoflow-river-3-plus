import { EventEmitter } from 'node:events';

import {
  applyDerivedFields,
  buildQuotaRequest,
  buildSetCommand,
  decodeTelemetry,
  parseQuotaReply,
  type Fields,
  type FieldValue,
  type SetField,
} from './protocol.js';
import type { Channel, Transport, TransportLog } from './transport.js';

export interface DeviceOptions {
  /** With no data for this long, and no word from EcoFlow that the unit is online, treat it as offline. */
  offlineAfterMs: number;
  /** How long to wait for the unit to confirm a change before showing the old value again. */
  commandTimeoutMs: number;
  /** How often to ask EcoFlow whether the unit is online. */
  pollIntervalMs: number;
}

export const DEFAULT_DEVICE_OPTIONS: DeviceOptions = {
  offlineAfterMs: 5 * 60_000,
  commandTimeoutMs: 10_000,
  pollIntervalMs: 60_000,
};

/** The settings this plugin can change: the state field to read and the command field to write. */
export const CONTROLS = {
  acOutput: { stateKey: 'cfg_ac_out_open', setField: 'cfg_ac_out_open' },
  dcOutput: { stateKey: 'cfg_dc12v_out_open', setField: 'cfg_dc12v_out_open' },
  xboost: { stateKey: 'xboost_en', setField: 'xboost_en' },
  ledMode: { stateKey: 'led_mode', setField: 'cfg_led_mode' },
} as const satisfies Record<string, { stateKey: string; setField: SetField }>;

export type ControlName = keyof typeof CONTROLS;

/** LED light bar modes on the RIVER 3 Plus. */
export const LED_MODE = { off: 0, dim: 1, bright: 2, sos: 3 } as const;

export class DeviceOfflineError extends Error {
  constructor(serialNumber: string) {
    super(`EcoFlow device ${serialNumber} is offline`);
    this.name = 'DeviceOfflineError';
  }
}

/** Keys from a latestQuotas reply that are worth keeping, after normalising their names. */
const QUOTA_KEYS = new Set([
  'cms_batt_soc', 'bms_batt_soc', 'cms_chg_dsg_state', 'bms_chg_dsg_state',
  'pow_in_sum_w', 'pow_out_sum_w', 'pow_get_ac_out', 'pow_get_ac_in', 'pow_get_12v',
  'flow_info_ac_out', 'flow_info_12v', 'cfg_ac_out_open', 'dc_out_open', 'xboost_en', 'led_mode',
  'plug_in_info_ac_charger_flag', 'plug_in_info_ac_in_flag',
]);

function normaliseQuotaKey(key: string): string {
  const last = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : key;
  return last.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * One RIVER 3 unit: keeps the latest known state, works out whether the unit
 * is reachable, and sends commands. Emits 'update' whenever something changes.
 */
export class River3Device extends EventEmitter {
  private state: Fields = {};
  private readonly pending = new Map<string, { value: number; timer: NodeJS.Timeout }>();
  private lastDataAt = 0;
  private cloudOnline?: boolean;
  private cloudOnlineAt = 0;
  private wasOnline = false;
  private pollTimer?: NodeJS.Timeout;
  private onlineTimer?: NodeJS.Timeout;

  private readonly onMessage = (serialNumber: string, channel: Channel, payload: Buffer) => {
    if (serialNumber === this.serialNumber) {
      this.handleMessage(channel, payload);
    }
  };
  private readonly onConnect = () => {
    this.requestStatus();
    this.refreshOnline();
  };
  private readonly onDisconnect = () => this.refreshOnline();

  constructor(
    readonly serialNumber: string,
    private readonly transport: Transport,
    private readonly log: TransportLog,
    private readonly options: DeviceOptions = DEFAULT_DEVICE_OPTIONS,
    private readonly now: () => number = Date.now,
  ) {
    super();
    transport.watch(serialNumber);
  }

  start(): void {
    this.transport.on('message', this.onMessage);
    this.transport.on('connect', this.onConnect);
    this.transport.on('disconnect', this.onDisconnect);
    this.pollTimer = setInterval(() => this.requestStatus(), this.options.pollIntervalMs);
    this.pollTimer.unref();
    this.onlineTimer = setInterval(() => this.refreshOnline(), Math.min(15_000, this.options.offlineAfterMs));
    this.onlineTimer.unref();
    if (this.transport.connected) {
      this.onConnect();
    }
  }

  stop(): void {
    this.transport.off('message', this.onMessage);
    this.transport.off('connect', this.onConnect);
    this.transport.off('disconnect', this.onDisconnect);
    clearInterval(this.pollTimer);
    clearInterval(this.onlineTimer);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }

  /** True when the unit can be reached through EcoFlow's cloud right now. */
  get online(): boolean {
    if (!this.transport.connected) {
      return false;
    }
    const now = this.now();
    const recentData = this.lastDataAt > 0 && now - this.lastDataAt < this.options.offlineAfterMs;
    if (recentData && !(this.cloudOnline === false && this.cloudOnlineAt > this.lastDataAt)) {
      return true;
    }
    const statusIsFresh = now - this.cloudOnlineAt < Math.max(this.options.offlineAfterMs, 2 * this.options.pollIntervalMs);
    return this.cloudOnline === true && statusIsFresh;
  }

  /** The latest value of a field, with any change we are still waiting on applied. */
  value(key: string): FieldValue | undefined {
    return this.pending.get(key)?.value ?? this.state[key];
  }

  private number(key: string): number | undefined {
    const value = this.value(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  /** Battery charge, 0 to 100, or undefined before the first report. */
  get batteryLevel(): number | undefined {
    const level = this.number('cms_batt_soc') ?? this.number('bms_batt_soc') ?? this.number('msg32_2_1_cms_batt_soc');
    return level === undefined ? undefined : Math.min(100, Math.max(0, Math.round(level)));
  }

  /** Battery temperature in degrees Celsius, or undefined before the first report. */
  get batteryTemperatureC(): number | undefined {
    const direct = this.number('temp');
    if (direct !== undefined) {
      return direct;
    }
    const minimum = this.number('bms_min_cell_temp');
    const maximum = this.number('bms_max_cell_temp');
    if (minimum !== undefined && maximum !== undefined) {
      return (minimum + maximum) / 2;
    }
    return maximum ?? minimum;
  }

  get charging(): boolean {
    const state = this.number('cms_chg_dsg_state') ?? this.number('bms_chg_dsg_state');
    if (state !== undefined) {
      return state === 2;
    }
    return (this.number('pow_in_sum_w') ?? 0) > 1;
  }

  /** Whether mains power is reaching the unit, or undefined if it has not said. */
  get mainsConnected(): boolean | undefined {
    const flag = this.number('plug_in_info_ac_charger_flag') ?? this.number('plug_in_info_ac_in_flag');
    return flag === undefined ? undefined : flag !== 0;
  }

  get inputWatts(): number {
    return Math.max(0, this.number('pow_in_sum_w') ?? 0);
  }

  get outputWatts(): number {
    return Math.abs(this.number('pow_out_sum_w') ?? 0);
  }

  get acOutputWatts(): number {
    return Math.abs(this.number('pow_get_ac_out') ?? 0);
  }

  get dcOutputWatts(): number {
    return Math.abs(this.number('pow_get_12v') ?? 0);
  }

  get usbAOutputWatts(): number {
    return Math.abs(this.number('pow_get_qcusb1') ?? 0) + Math.abs(this.number('pow_get_qcusb2') ?? 0);
  }

  get usbCOutputWatts(): number {
    return Math.abs(this.number('pow_get_typec1') ?? 0) + Math.abs(this.number('pow_get_typec2') ?? 0);
  }

  /** Lifetime energy delivered by the AC outlets, in watt-hours, if the unit has reported it. */
  get acOutputEnergyWh(): number | undefined {
    return this.number('ac_out_energy');
  }

  /** Lifetime energy delivered by the 12 V outlet, in watt-hours, if the unit has reported it. */
  get dcOutputEnergyWh(): number | undefined {
    return this.number('dc12v_out_energy');
  }

  isOn(control: Exclude<ControlName, 'ledMode'>): boolean {
    return (this.number(CONTROLS[control].stateKey) ?? 0) !== 0;
  }

  get ledMode(): number {
    return this.number(CONTROLS.ledMode.stateKey) ?? LED_MODE.off;
  }

  /** Send a change to the unit. Throws DeviceOfflineError if it cannot be reached. */
  set(control: ControlName, value: number): void {
    const { stateKey, setField } = CONTROLS[control];
    if (!this.online) {
      throw new DeviceOfflineError(this.serialNumber);
    }
    if (!this.transport.sendSet(this.serialNumber, buildSetCommand(setField, value, this.serialNumber))) {
      throw new DeviceOfflineError(this.serialNumber);
    }
    this.log.debug(`[${this.serialNumber}] sent ${setField}=${value}`);

    const previous = this.pending.get(stateKey);
    if (previous) {
      clearTimeout(previous.timer);
    }
    const timer = setTimeout(() => {
      this.pending.delete(stateKey);
      if (this.state[stateKey] !== value) {
        this.log.warn(`[${this.serialNumber}] the unit did not confirm ${setField}=${value}; showing its last known state`);
      }
      this.emit('update');
    }, this.options.commandTimeoutMs);
    timer.unref();
    this.pending.set(stateKey, { value, timer });
    this.emit('update');
  }

  private requestStatus(): void {
    this.transport.sendGet(this.serialNumber, buildQuotaRequest());
  }

  private handleMessage(channel: Channel, payload: Buffer): void {
    if (payload.length === 0) {
      return;
    }
    if (payload[0] === 0x7b) {
      this.handleJson(payload);
      return;
    }
    let fields: Fields;
    try {
      fields = decodeTelemetry(payload);
    } catch (error) {
      this.log.debug(`[${this.serialNumber}] could not decode a ${channel} message: ${(error as Error).message}`);
      return;
    }
    if (Object.keys(fields).length === 0) {
      this.log.debug(`[${this.serialNumber}] ${channel}: nothing recognised in ${payload.length} bytes`);
      return;
    }
    this.log.debug(`[${this.serialNumber}] ${channel}: ${JSON.stringify(fields)}`);
    if (channel === 'data') {
      this.lastDataAt = this.now();
    }
    this.merge(fields, true);
  }

  private handleJson(payload: Buffer): void {
    const reply = parseQuotaReply(payload);
    if (!reply) {
      return;
    }
    this.cloudOnline = reply.online;
    this.cloudOnlineAt = this.now();
    this.log.debug(
      `[${this.serialNumber}] EcoFlow says the unit is ${reply.online ? 'online' : 'offline'}; cached keys: ${Object.keys(reply.quotaMap).join(', ') || 'none'}`,
    );
    const fields: Fields = {};
    for (const [rawKey, value] of Object.entries(reply.quotaMap)) {
      const key = normaliseQuotaKey(rawKey);
      if (QUOTA_KEYS.has(key) && typeof value === 'number') {
        fields[key] = value;
      }
    }
    // The cloud's cached values only fill gaps; they never replace what the unit itself reported.
    this.merge(applyDerivedFields(fields), false);
  }

  private merge(fields: Fields, overwrite: boolean): void {
    let changed = false;
    for (const [key, value] of Object.entries(fields)) {
      if (!overwrite && key in this.state) {
        continue;
      }
      if (this.state[key] !== value) {
        this.state[key] = value;
        changed = true;
      }
      const waiting = overwrite ? this.pending.get(key) : undefined;
      if (waiting) {
        // The unit has spoken about this setting, so its word replaces our assumption.
        clearTimeout(waiting.timer);
        this.pending.delete(key);
        changed = true;
      }
    }
    const onlineChanged = this.syncOnline();
    if (changed || onlineChanged) {
      this.emit('update');
    }
  }

  private refreshOnline(): void {
    if (this.syncOnline()) {
      this.emit('update');
    }
  }

  /** Record the current reachability. Returns true if it changed. */
  private syncOnline(): boolean {
    const online = this.online;
    if (online === this.wasOnline) {
      return false;
    }
    this.wasOnline = online;
    this.log.info(`[${this.serialNumber}] is now ${online ? 'online' : 'offline'}`);
    return true;
  }
}
