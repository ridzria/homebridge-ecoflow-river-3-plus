import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildQuotaRequest,
  buildSetCommand,
  decodePackets,
  decodeSetCommand,
  decodeTelemetry,
  encode,
  flowIsOn,
  generateSeq,
  parseQuotaReply,
  type SetField,
} from '../src/ecoflow/protocol.js';
import { referenceFixtures } from './helpers.js';

const fixtures = referenceFixtures();

describe('commands', () => {
  for (const fixture of fixtures.commands) {
    it(`${fixture.field}=${fixture.value} matches the reference implementation byte for byte`, () => {
      const packet = buildSetCommand(fixture.field as SetField, fixture.value, fixture.sn, fixture.seq);
      assert.equal(packet.toString('hex'), fixture.hex);
    });
  }

  it('round-trips through the command decoder', () => {
    const decoded = decodeSetCommand(buildSetCommand('cfg_led_mode', 1, 'R631TEST'));
    assert.deepEqual(decoded?.command, { cfg_led_mode: 1 });
    assert.equal(decoded?.header.device_sn, 'R631TEST');
    assert.equal(decoded?.header.cmd_func, 254);
    assert.equal(decoded?.header.cmd_id, 17);
  });

  it('rejects a field the device does not have', () => {
    assert.throws(() => buildSetCommand('not_a_field' as SetField, 1, 'R631TEST'), /Unknown RIVER 3 set field/);
  });

  it('generates sequence numbers in the reference range', () => {
    assert.equal(generateSeq(() => 0), 999910000);
    assert.equal(generateSeq(() => 0.999999), 999999999);
  });
});

describe('telemetry', () => {
  for (const fixture of fixtures.telemetry) {
    it(`decodes: ${fixture.name}`, () => {
      const merged = {};
      for (const packet of decodePackets(Buffer.from(fixture.hex, 'hex'))) {
        Object.assign(merged, packet.fields);
      }
      assert.deepEqual(merged, fixture.expected);
    });
  }

  it('accepts a payload wrapped in base64 text', () => {
    const fixture = fixtures.telemetry[0]!;
    const wrapped = Buffer.from(Buffer.from(fixture.hex, 'hex').toString('base64'), 'latin1');
    const fields = decodeTelemetry(wrapped);
    assert.equal(fields.cms_batt_soc, 87.5);
  });

  it('derives the AC and 12 V switch states from the flow fields', () => {
    const on = decodeTelemetry(
      encode.envelope([{ cmdFunc: 254, cmdId: 21, pdata: encode.display({ flow_info_ac_out: 2, flow_info_12v: 2 }) }]),
    );
    assert.equal(on.cfg_ac_out_open, 1);
    assert.equal(on.cfg_dc12v_out_open, 1);
    const off = decodeTelemetry(
      encode.envelope([{ cmdFunc: 254, cmdId: 21, pdata: encode.display({ flow_info_ac_out: 0, flow_info_12v: 0 }) }]),
    );
    assert.equal(off.cfg_ac_out_open, 0);
    assert.equal(off.cfg_dc12v_out_open, 0);
  });

  it('lets a direct value win over the flow fields', () => {
    const fields = decodeTelemetry(
      encode.envelope([
        { cmdFunc: 254, cmdId: 21, pdata: encode.display({ flow_info_ac_out: 0 }) },
        { cmdFunc: 254, cmdId: 18, pdata: encode.setReply({ config_ok: true, cfg_ac_out_open: 1 }) },
      ]),
    );
    assert.equal(fields.cfg_ac_out_open, 1);
  });

  it('does not invent switch states that were not reported', () => {
    const fields = decodeTelemetry(
      encode.envelope([{ cmdFunc: 254, cmdId: 21, pdata: encode.display({ cms_batt_soc: 50 }) }]),
    );
    assert.deepEqual(fields, { cms_batt_soc: 50 });
  });

  it('reads the flow bitmask the way the app does', () => {
    assert.equal(flowIsOn(0), false);
    assert.equal(flowIsOn(1), false);
    assert.equal(flowIsOn(2), true);
    assert.equal(flowIsOn(3), true);
    assert.equal(flowIsOn(4), false);
    assert.equal(flowIsOn(6), true);
  });

  it('skips an unreadable header but keeps the rest of the payload', () => {
    const good = encode.display({ cms_batt_soc: 42 });
    const payload = encode.envelope([
      { cmdFunc: 254, cmdId: 21, pdata: Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff]) },
      { cmdFunc: 254, cmdId: 21, pdata: good },
    ]);
    assert.equal(decodeTelemetry(payload).cms_batt_soc, 42);
  });

  it('ignores an unknown message that is not a BMS heartbeat', () => {
    const payload = encode.envelope([{ cmdFunc: 99, cmdId: 99, pdata: encode.bmsHeartbeat({ soc: 50 }) }]);
    assert.deepEqual(decodeTelemetry(payload), {});
  });
});

describe('status requests', () => {
  it('builds a latestQuotas request', () => {
    assert.deepEqual(JSON.parse(buildQuotaRequest(999912345)), {
      from: 'Homebridge',
      id: '999912345',
      version: '1.1',
      moduleType: 0,
      operateType: 'latestQuotas',
      params: {},
    });
  });

  it('parses a latestQuotas reply', () => {
    const reply = Buffer.from(JSON.stringify({ operateType: 'latestQuotas', data: { online: 1, quotaMap: { a: 1 } } }));
    assert.deepEqual(parseQuotaReply(reply), { online: true, quotaMap: { a: 1 } });
    const offline = Buffer.from(JSON.stringify({ operateType: 'latestQuotas', data: { online: 0 } }));
    assert.deepEqual(parseQuotaReply(offline), { online: false, quotaMap: {} });
  });

  it('ignores other JSON and broken JSON', () => {
    assert.equal(parseQuotaReply(Buffer.from('{"operateType":"other"}')), undefined);
    assert.equal(parseQuotaReply(Buffer.from('{not json')), undefined);
    assert.equal(parseQuotaReply(Buffer.from([0x0a, 0x00])), undefined);
  });
});
