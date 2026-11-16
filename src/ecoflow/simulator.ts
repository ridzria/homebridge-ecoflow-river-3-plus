import { EventEmitter } from 'node:events';

import { decodeSetCommand, encode, generateSeq } from './protocol.js';
import type { Transport } from './transport.js';

interface SimulatedUnit {
  soc: number;
  temperatureC: number;
  acOn: boolean;
  dcOn: boolean;
  xboost: boolean;
  ledMode: number;
  mains: boolean;
}

const CMD_FUNC = 254;
const DISPLAY = 21;
const SET_REPLY = 18;
const BMS_FUNC = 3;
const BMS_HEARTBEAT = 1;

/**
 * A stand-in for EcoFlow's cloud and a RIVER 3 Plus, for trying the plugin
 * without a unit or an account. It speaks the same protobuf messages as the
 * real thing, so everything above the transport runs unchanged.
 */
export class SimulatorTransport extends EventEmitter implements Transport {
  private readonly units = new Map<string, SimulatedUnit>();
  private timer?: NodeJS.Timeout;
  private isConnected = false;

  constructor(
    private readonly tickMs = 10_000,
    private readonly replyDelayMs = 200,
  ) {
    super();
  }

  get connected(): boolean {
    return this.isConnected;
  }

  watch(serialNumber: string): void {
    this.units.set(serialNumber, {
      soc: 76,
      temperatureC: 27,
      acOn: true,
      dcOn: false,
      xboost: false,
      ledMode: 0,
      mains: true,
    });
  }

  start(): void {
    this.isConnected = true;
    this.emit('connect');
    for (const serialNumber of this.units.keys()) {
      this.sendDisplay(serialNumber, true);
      this.sendBmsHeartbeat(serialNumber);
    }
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.isConnected = false;
    this.emit('disconnect');
  }

  sendSet(serialNumber: string, payload: Buffer): boolean {
    const unit = this.units.get(serialNumber);
    const decoded = decodeSetCommand(payload);
    if (!unit || !decoded) {
      return false;
    }
    const { command } = decoded;
    if (typeof command.cfg_ac_out_open === 'number') {
      unit.acOn = command.cfg_ac_out_open !== 0;
    }
    if (typeof command.cfg_dc12v_out_open === 'number') {
      unit.dcOn = command.cfg_dc12v_out_open !== 0;
    }
    if (typeof command.xboost_en === 'number') {
      unit.xboost = command.xboost_en !== 0;
    }
    if (typeof command.cfg_led_mode === 'number') {
      unit.ledMode = command.cfg_led_mode;
    }
    const reply = setTimeout(() => {
      const seq = generateSeq();
      this.emit(
        'message',
        serialNumber,
        'set_reply',
        encode.envelope([
          { cmdFunc: CMD_FUNC, cmdId: SET_REPLY, seq, encType: 1, pdata: encode.setReply({ config_ok: true, ...command }) },
        ]),
      );
      this.sendDisplay(serialNumber, false);
      this.sendBmsHeartbeat(serialNumber);
    }, this.replyDelayMs);
    reply.unref();
    return true;
  }

  sendGet(serialNumber: string, _payload: string): boolean {
    if (!this.units.has(serialNumber)) {
      return false;
    }
    const reply = setTimeout(() => {
      this.emit(
        'message',
        serialNumber,
        'get_reply',
        Buffer.from(JSON.stringify({ operateType: 'latestQuotas', data: { online: 1, quotaMap: {} } })),
      );
    }, this.replyDelayMs);
    reply.unref();
    return true;
  }

  /** Pull or restore the simulated mains supply. Used by tests. */
  setMains(serialNumber: string, connected: boolean): void {
    const unit = this.units.get(serialNumber);
    if (unit) {
      unit.mains = connected;
      this.sendDisplay(serialNumber, false);
    }
  }

  private tick(): void {
    for (const [serialNumber, unit] of this.units) {
      // Charge slowly on mains, drain slowly on battery.
      unit.soc = Math.min(100, Math.max(5, unit.soc + (unit.mains ? 1 : -1)));
      this.sendDisplay(serialNumber, false);
    }
  }

  private sendDisplay(serialNumber: string, full: boolean): void {
    const unit = this.units.get(serialNumber);
    if (!unit) {
      return;
    }
    const acLoad = unit.acOn ? 58 : 0;
    const dcLoad = unit.dcOn ? 12 : 0;
    const charging = unit.mains && unit.soc < 100;
    const fields: Record<string, unknown> = {
      cms_batt_soc: unit.soc,
      bms_batt_soc: unit.soc,
      cms_batt_soh: 100,
      soh: 1,
      cycles: 1,
      bms_min_cell_temp: unit.temperatureC,
      bms_max_cell_temp: unit.temperatureC,
      cms_chg_dsg_state: charging ? 2 : unit.mains ? 0 : 1,
      pow_in_sum_w: unit.mains ? acLoad + dcLoad + (charging ? 100 : 0) : 0,
      pow_out_sum_w: acLoad + dcLoad,
      pow_get_ac_out: -acLoad,
      pow_get_12v: -dcLoad,
      pow_get_qcusb1: 0,
      pow_get_qcusb2: 0,
      pow_get_typec1: 0,
      pow_get_typec2: 0,
      flow_info_ac_out: unit.acOn ? 2 : 0,
      flow_info_12v: unit.dcOn ? 2 : 0,
      xboost_en: unit.xboost ? 1 : 0,
      led_mode: unit.ledMode,
      plug_in_info_ac_charger_flag: unit.mains ? 1 : 0,
    };
    if (full) {
      fields.bms_design_cap = 14000;
      fields.cms_max_chg_soc = 100;
      fields.cms_min_dsg_soc = 0;
    }
    this.emit(
      'message',
      serialNumber,
      'data',
      encode.envelope([{ cmdFunc: CMD_FUNC, cmdId: DISPLAY, seq: generateSeq(), encType: 1, pdata: encode.display(fields) }]),
    );
  }

  private sendBmsHeartbeat(serialNumber: string): void {
    this.emit(
      'message',
      serialNumber,
      'data',
      encode.envelope([
        {
          cmdFunc: BMS_FUNC,
          cmdId: BMS_HEARTBEAT,
          src: 3,
          pdata: encode.bmsHeartbeat({ cycles: 1, soh: 100, temp: 27 }),
        },
      ]),
    );
  }
}
