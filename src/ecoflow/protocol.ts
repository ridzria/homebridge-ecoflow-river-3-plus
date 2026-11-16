/**
 * Wire protocol for the EcoFlow RIVER 3 family.
 *
 * The message layout and field numbers come from the hassio-ecoflow-cloud
 * project (Apache-2.0), see proto/ef_river3.proto and NOTICE.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import protobuf from 'protobufjs';

export type FieldValue = number | string | boolean;
export type Fields = Record<string, FieldValue>;

/** Fields of River3SetCommand that this plugin writes. */
export type SetField =
  | 'cfg_ac_out_open'
  | 'cfg_dc12v_out_open'
  | 'xboost_en'
  | 'cfg_led_mode'
  | 'en_beep'
  | 'cms_max_chg_soc';

export interface PacketInfo {
  src: number;
  cmdFunc: number;
  cmdId: number;
  seq: number;
  encType: number;
  fields: Fields;
}

const CMD_FUNC_PROPERTY = 254;
const CMD_ID_SET = 17;
const CMD_ID_SET_REPLY = 18;
const CMD_ID_DISPLAY = 21;
const CMD_ID_RUNTIME = 22;
const CMD_FUNC_CMS = 32;
const CMD_ID_CMS_HEARTBEAT = 2;

/** (cmdFunc, cmdId) pairs that carry a BMS heartbeat. */
const BMS_HEARTBEATS = new Set([
  '3:1', '3:2', '3:30', '3:50',
  '32:1', '32:3', '32:50', '32:51', '32:52',
  '254:24', '254:25', '254:26', '254:27', '254:28', '254:29', '254:30',
]);

function findProtoFile(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'proto', 'ef_river3.proto');
    if (existsSync(candidate)) {
      return candidate;
    }
    dir = dirname(dir);
  }
  throw new Error('ef_river3.proto was not found next to the plugin');
}

const root = protobuf.parse(readFileSync(findProtoFile(), 'utf8'), { keepCase: true }).root;

const types = {
  headerMessage: root.lookupType('River3HeaderMessage'),
  sendHeaderMsg: root.lookupType('River3SendHeaderMsg'),
  display: root.lookupType('River3DisplayPropertyUpload'),
  runtime: root.lookupType('River3RuntimePropertyUpload'),
  setCommand: root.lookupType('River3SetCommand'),
  setReply: root.lookupType('River3SetReply'),
  cmsHeartbeat: root.lookupType('River3CMSHeartBeatReport'),
  bmsHeartbeat: root.lookupType('River3BMSHeartBeatReport'),
};

const TO_OBJECT = { enums: String, longs: Number, defaults: false, arrays: false, oneofs: false } as const;

function toPlain(type: protobuf.Type, data: Uint8Array): Record<string, unknown> {
  return type.toObject(type.decode(data), TO_OBJECT) as Record<string, unknown>;
}

/** Flatten nested messages as parent_child and drop anything that is not a scalar. */
function flatten(source: Record<string, unknown>, prefix = '', into: Fields = {}): Fields {
  for (const [key, value] of Object.entries(source)) {
    const name = prefix ? `${prefix}_${key}` : key;
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      into[name] = value;
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) {
      flatten(value as Record<string, unknown>, name, into);
    }
  }
  return into;
}

/** Lift display_statistics_sum.list_info entries into flat fields such as ac_out_energy. */
function extractStatistics(data: Record<string, unknown>): void {
  const sum = data.display_statistics_sum as { list_info?: unknown } | undefined;
  const list = Array.isArray(sum?.list_info) ? sum.list_info : [];
  for (const item of list as Array<Record<string, unknown>>) {
    const object = item.statistics_object;
    const content = item.statistics_content;
    if (typeof object === 'string' && object.startsWith('STATISTICS_OBJECT_') && typeof content === 'number') {
      data[object.slice('STATISTICS_OBJECT_'.length).toLowerCase()] = content;
    }
  }
  delete data.display_statistics_sum;
}

function xor(pdata: Uint8Array, seq: number): Uint8Array {
  const key = seq & 0xff;
  const out = new Uint8Array(pdata.length);
  for (let i = 0; i < pdata.length; i++) {
    out[i] = (pdata[i] as number) ^ key;
  }
  return out;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** EcoFlow sometimes wraps the protobuf bytes in base64 text. */
function unwrapBase64(payload: Buffer): Buffer {
  if (payload.length === 0 || payload.length % 4 !== 0) {
    return payload;
  }
  const text = payload.toString('latin1');
  return BASE64.test(text) ? Buffer.from(text, 'base64') : payload;
}

function decodeBody(cmdFunc: number, cmdId: number, pdata: Uint8Array): Record<string, unknown> {
  if (cmdFunc === CMD_FUNC_PROPERTY && cmdId === CMD_ID_DISPLAY) {
    const data = toPlain(types.display, pdata);
    extractStatistics(data);
    return data;
  }
  if (cmdFunc === CMD_FUNC_PROPERTY && cmdId === CMD_ID_RUNTIME) {
    return toPlain(types.runtime, pdata);
  }
  if (cmdFunc === CMD_FUNC_PROPERTY && cmdId === CMD_ID_SET) {
    return toPlain(types.setCommand, pdata);
  }
  if (cmdFunc === CMD_FUNC_PROPERTY && cmdId === CMD_ID_SET_REPLY) {
    const reply = toPlain(types.setReply, pdata);
    // A reply only describes real device state when the unit accepted the change.
    return reply.config_ok === true ? reply : {};
  }
  if (cmdFunc === CMD_FUNC_CMS && cmdId === CMD_ID_CMS_HEARTBEAT) {
    return toPlain(types.cmsHeartbeat, pdata);
  }
  if (BMS_HEARTBEATS.has(`${cmdFunc}:${cmdId}`)) {
    return toPlain(types.bmsHeartbeat, pdata);
  }
  // Unknown message: accept it as a BMS heartbeat only if it clearly is one.
  const guess = toPlain(types.bmsHeartbeat, pdata);
  return 'cycles' in guess || 'accu_chg_energy' in guess || 'accu_dsg_energy' in guess ? guess : {};
}

/** Decode every header in an MQTT payload. Headers that fail to decode are skipped. */
export function decodePackets(payload: Buffer): PacketInfo[] {
  const envelope = types.headerMessage.decode(unwrapBase64(payload)) as unknown as {
    header?: Array<Record<string, unknown>>;
  };
  const packets: PacketInfo[] = [];
  for (const header of envelope.header ?? []) {
    const pdata = header.pdata as Uint8Array | undefined;
    if (!pdata || pdata.length === 0) {
      continue;
    }
    const src = Number(header.src ?? 0);
    const seq = Number(header.seq ?? 0);
    const encType = Number(header.enc_type ?? 0);
    const cmdFunc = Number(header.cmd_func ?? 0);
    const cmdId = Number(header.cmd_id ?? 0);
    try {
      const body = encType === 1 && src !== 32 ? xor(pdata, seq) : pdata;
      packets.push({ src, seq, encType, cmdFunc, cmdId, fields: flatten(decodeBody(cmdFunc, cmdId, body)) });
    } catch {
      // Skip a header we cannot read; the rest of the payload may still be fine.
    }
  }
  return packets;
}

/** Flow-info values are a bitmask: bit 1 set means the port is switched on. */
export function flowIsOn(value: number): boolean {
  return (value & 0b11) >= 0b10;
}

/**
 * Add the switch states the firmware does not report directly. The live output
 * state is carried by the flow-info fields; a direct value (for example from a
 * set reply) always wins when present.
 */
export function applyDerivedFields(fields: Fields): Fields {
  if (!('cfg_ac_out_open' in fields) && typeof fields.flow_info_ac_out === 'number') {
    fields.cfg_ac_out_open = flowIsOn(fields.flow_info_ac_out) ? 1 : 0;
  }
  if (!('cfg_dc12v_out_open' in fields)) {
    if (typeof fields.dc_out_open === 'number') {
      fields.cfg_dc12v_out_open = fields.dc_out_open ? 1 : 0;
    } else if (typeof fields.flow_info_12v === 'number') {
      fields.cfg_dc12v_out_open = flowIsOn(fields.flow_info_12v) ? 1 : 0;
    }
  }
  if (!('led_mode' in fields) && typeof fields.cfg_led_mode === 'number') {
    fields.led_mode = fields.cfg_led_mode;
  }
  return fields;
}

/** Decode an MQTT payload into one flat set of fields, including the derived switch states. */
export function decodeTelemetry(payload: Buffer): Fields {
  const merged: Fields = {};
  for (const packet of decodePackets(payload)) {
    Object.assign(merged, packet.fields);
  }
  return applyDerivedFields(merged);
}

/** Sequence numbers follow the reference implementation: 9999xxxxx. */
export function generateSeq(random: () => number = Math.random): number {
  return 999900000 + 10000 + Math.floor(random() * 90000);
}

/** Build the protobuf packet that sets one field on the device. */
export function buildSetCommand(field: SetField, value: number, deviceSn: string, seq = generateSeq()): Buffer {
  if (!(field in types.setCommand.fields)) {
    throw new Error(`Unknown RIVER 3 set field: ${field}`);
  }
  const pdata = types.setCommand.encode(types.setCommand.create({ [field]: Math.trunc(value) })).finish();
  const packet = types.sendHeaderMsg.create({
    msg: [
      {
        pdata,
        src: 32,
        dest: 2,
        d_src: 1,
        d_dest: 1,
        cmd_func: CMD_FUNC_PROPERTY,
        cmd_id: CMD_ID_SET,
        // The reference sends a fixed length of 2 for the beeper.
        data_len: field === 'en_beep' ? 2 : pdata.length,
        need_ack: 1,
        seq,
        product_id: 1,
        version: 19,
        payload_ver: 1,
        device_sn: deviceSn,
      },
    ],
  });
  return Buffer.from(types.sendHeaderMsg.encode(packet).finish());
}

/** JSON request that asks EcoFlow's cloud for the device's latest values and online flag. */
export function buildQuotaRequest(seq = generateSeq()): string {
  return JSON.stringify({
    from: 'Homebridge',
    id: String(seq),
    version: '1.1',
    moduleType: 0,
    operateType: 'latestQuotas',
    params: {},
  });
}

export interface QuotaReply {
  online: boolean;
  quotaMap: Record<string, unknown>;
}

/** Parse a JSON latestQuotas reply. Returns undefined for anything else. */
export function parseQuotaReply(payload: Buffer): QuotaReply | undefined {
  if (payload[0] !== 0x7b) {
    return undefined;
  }
  try {
    const message = JSON.parse(payload.toString('utf8')) as {
      operateType?: string;
      data?: { online?: unknown; quotaMap?: Record<string, unknown> };
    };
    if (message.operateType !== 'latestQuotas' || !message.data) {
      return undefined;
    }
    return { online: Number(message.data.online) === 1, quotaMap: message.data.quotaMap ?? {} };
  } catch {
    return undefined;
  }
}

/** Encoders for tests and the simulator: they build the messages a real unit would send. */
export const encode = {
  display(fields: Record<string, unknown>): Uint8Array {
    return types.display.encode(types.display.create(fields)).finish();
  },
  runtime(fields: Record<string, unknown>): Uint8Array {
    return types.runtime.encode(types.runtime.create(fields)).finish();
  },
  setReply(fields: Record<string, unknown>): Uint8Array {
    return types.setReply.encode(types.setReply.create(fields)).finish();
  },
  bmsHeartbeat(fields: Record<string, unknown>): Uint8Array {
    return types.bmsHeartbeat.encode(types.bmsHeartbeat.create(fields)).finish();
  },
  /** Wrap message bodies in the header envelope, XOR-scrambled like the device does when encType is 1. */
  envelope(
    packets: Array<{ cmdFunc: number; cmdId: number; pdata: Uint8Array; src?: number; seq?: number; encType?: number }>,
  ): Buffer {
    const header = packets.map((p) => {
      const src = p.src ?? 2;
      const seq = p.seq ?? 0;
      const encType = p.encType ?? 0;
      return {
        pdata: encType === 1 && src !== 32 ? xor(p.pdata, seq) : p.pdata,
        src,
        dest: 32,
        enc_type: encType,
        cmd_func: p.cmdFunc,
        cmd_id: p.cmdId,
        data_len: p.pdata.length,
        seq,
      };
    });
    return Buffer.from(types.headerMessage.encode(types.headerMessage.create({ header })).finish());
  },
};

/** Decode a command packet as sent to the set topic. Used by the simulator and tests. */
export function decodeSetCommand(payload: Buffer): { header: Record<string, unknown>; command: Fields } | undefined {
  const packet = types.sendHeaderMsg.decode(payload) as unknown as { msg?: Array<Record<string, unknown>> };
  const header = packet.msg?.[0];
  if (!header || !(header.pdata instanceof Uint8Array)) {
    return undefined;
  }
  const plain = types.sendHeaderMsg.toObject(packet as unknown as protobuf.Message, TO_OBJECT) as {
    msg: Array<Record<string, unknown>>;
  };
  return {
    header: plain.msg[0] as Record<string, unknown>,
    command: flatten(toPlain(types.setCommand, header.pdata)),
  };
}
