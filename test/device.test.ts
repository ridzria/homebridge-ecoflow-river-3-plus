import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { DeviceOfflineError, LED_MODE, River3Device, type DeviceOptions } from '../src/ecoflow/device.js';
import { decodeSetCommand, encode } from '../src/ecoflow/protocol.js';
import { FakeTransport, recordingLog } from './helpers.js';

const SN = 'R631TEST';
const options: DeviceOptions = { offlineAfterMs: 300_000, commandTimeoutMs: 10_000, pollIntervalMs: 60_000 };

function display(fields: Record<string, unknown>): Buffer {
  return encode.envelope([{ cmdFunc: 254, cmdId: 21, seq: 1234, encType: 1, pdata: encode.display(fields) }]);
}

function quota(online: number, quotaMap: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ operateType: 'latestQuotas', data: { online, quotaMap } }));
}

function setup() {
  const transport = new FakeTransport();
  const log = recordingLog();
  const clock = { now: 1_000_000 };
  const device = new River3Device(SN, transport, log, options, () => clock.now);
  const updates = { count: 0 };
  device.on('update', () => updates.count++);
  device.start();
  /** Move the device's clock and the timers forward together. */
  const advance = (ms: number) => {
    clock.now += ms;
    mock.timers.tick(ms);
  };
  return { transport, log, device, updates, advance };
}

describe('River 3 device', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }));
  afterEach(() => mock.timers.reset());

  it('registers its serial number and asks for status on connect', () => {
    const { transport } = setup();
    assert.deepEqual(transport.watched, [SN]);
    assert.equal(transport.gets.length, 0);
    transport.goOnline();
    assert.equal(transport.gets.length, 1);
    assert.equal(JSON.parse(transport.gets[0]!.payload).operateType, 'latestQuotas');
  });

  it('keeps asking for status on a timer', () => {
    const { transport, advance } = setup();
    transport.goOnline();
    advance(60_000);
    advance(60_000);
    assert.equal(transport.gets.length, 3);
  });

  it('reads battery, outputs and power from a display message', () => {
    const { transport, device, updates } = setup();
    transport.goOnline();
    transport.deliver(
      SN,
      'data',
      display({
        cms_batt_soc: 87.6,
        cms_chg_dsg_state: 2,
        pow_in_sum_w: 120.5,
        pow_out_sum_w: 58,
        pow_get_ac_out: -46.5,
        pow_get_12v: -11.5,
        flow_info_ac_out: 2,
        flow_info_12v: 0,
        xboost_en: 1,
        led_mode: 1,
        plug_in_info_ac_charger_flag: 1,
      }),
    );
    assert.equal(device.online, true);
    assert.equal(device.batteryLevel, 88);
    assert.equal(device.charging, true);
    assert.equal(device.inputWatts, 120.5);
    assert.equal(device.outputWatts, 58);
    assert.equal(device.acOutputWatts, 46.5);
    assert.equal(device.dcOutputWatts, 11.5);
    assert.equal(device.isOn('acOutput'), true);
    assert.equal(device.isOn('dcOutput'), false);
    assert.equal(device.isOn('xboost'), true);
    assert.equal(device.ledMode, LED_MODE.dim);
    assert.equal(device.mainsConnected, true);
    assert.ok(updates.count >= 1);
  });

  it('reads prefixed charge and discharge remaining times', () => {
    const { transport, device } = setup();
    transport.goOnline();
    transport.deliver(SN, 'get_reply', quota(1, {
      msg32_2_1_cms_chg_rem_time: 5939,
      msg32_2_1_cms_dsg_rem_time: 2490,
    }));

    assert.equal(device.chargeRemainingMinutes, 5939);
    assert.equal(device.dischargeRemainingMinutes, 2490);
  });

  it('reads the PV energy total from cached status', () => {
    const { transport, device } = setup();
    transport.goOnline();
    transport.deliver(SN, 'get_reply', quota(1, { pv_in_energy: 70 }));
    assert.equal(device.pvInputEnergyWh, 70);
  });

  it('ignores messages for other serial numbers', () => {
    const { transport, device } = setup();
    transport.goOnline();
    transport.deliver('R631OTHER', 'data', display({ cms_batt_soc: 12 }));
    assert.equal(device.batteryLevel, undefined);
    assert.equal(device.online, false);
  });

  it('merges incremental messages and only announces real changes', () => {
    const { transport, device, updates } = setup();
    transport.goOnline();
    transport.deliver(SN, 'data', display({ cms_batt_soc: 50, flow_info_ac_out: 2 }));
    const after = updates.count;
    transport.deliver(SN, 'data', display({ cms_batt_soc: 50 }));
    assert.equal(updates.count, after);
    transport.deliver(SN, 'data', display({ cms_batt_soc: 49 }));
    assert.equal(updates.count, after + 1);
    assert.equal(device.batteryLevel, 49);
    assert.equal(device.isOn('acOutput'), true);
  });

  it('falls back to input power when no charging state has been reported', () => {
    const { transport, device } = setup();
    transport.goOnline();
    transport.deliver(SN, 'data', display({ pow_in_sum_w: 90 }));
    assert.equal(device.charging, true);
    transport.deliver(SN, 'data', display({ pow_in_sum_w: 0 }));
    assert.equal(device.charging, false);
    transport.deliver(SN, 'data', display({ pow_in_sum_w: 90, cms_chg_dsg_state: 0 }));
    assert.equal(device.charging, false);
  });

  it('reports a mains failure', () => {
    const { transport, device } = setup();
    transport.goOnline();
    assert.equal(device.mainsConnected, undefined);
    transport.deliver(SN, 'data', display({ plug_in_info_ac_charger_flag: 0 }));
    assert.equal(device.mainsConnected, false);
  });

  it('is offline until the unit or the cloud says otherwise', () => {
    const { transport, device, log } = setup();
    assert.equal(device.online, false);
    transport.goOnline();
    assert.equal(device.online, false);
    transport.deliver(SN, 'get_reply', quota(1));
    assert.equal(device.online, true);
    assert.ok(log.has('info', 'is now online'));
    transport.deliver(SN, 'get_reply', quota(0));
    assert.equal(device.online, false);
    assert.ok(log.has('info', 'is now offline'));
  });

  it('goes offline when the data stops and the cloud stays silent', () => {
    const { transport, device, updates, advance } = setup();
    transport.goOnline();
    transport.deliver(SN, 'data', display({ cms_batt_soc: 50 }));
    advance(299_000);
    assert.equal(device.online, true);
    const before = updates.count;
    advance(16_000);
    assert.equal(device.online, false);
    assert.equal(updates.count, before + 1);
  });

  it('stays online without data while the cloud keeps confirming it', () => {
    const { transport, device, advance } = setup();
    transport.goOnline();
    transport.deliver(SN, 'data', display({ cms_batt_soc: 50 }));
    for (let minute = 0; minute < 10; minute++) {
      advance(60_000);
      transport.deliver(SN, 'get_reply', quota(1));
    }
    assert.equal(device.online, true);
  });

  it('trusts fresh data over an older "offline" from the cloud', () => {
    const { transport, device, advance } = setup();
    transport.goOnline();
    transport.deliver(SN, 'get_reply', quota(0));
    advance(1_000);
    transport.deliver(SN, 'data', display({ cms_batt_soc: 50 }));
    assert.equal(device.online, true);
  });

  it('goes offline when the connection drops', () => {
    const { transport, device, updates } = setup();
    transport.goOnline();
    transport.deliver(SN, 'data', display({ cms_batt_soc: 50 }));
    const before = updates.count;
    transport.goOffline();
    assert.equal(device.online, false);
    assert.equal(updates.count, before + 1);
  });

  it('only uses cached cloud values to fill gaps', () => {
    const { transport, device } = setup();
    transport.goOnline();
    transport.deliver(SN, 'data', display({ cms_batt_soc: 50 }));
    transport.deliver(SN, 'get_reply', quota(1, { 'pd.cmsBattSoc': 99, flowInfoAcOut: 2, somethingElse: 7, xboostEn: 'yes' }));
    assert.equal(device.batteryLevel, 50);
    assert.equal(device.isOn('acOutput'), true);
    assert.equal(device.value('something_else'), undefined);
    assert.equal(device.value('xboost_en'), undefined);
  });

  it('refuses to send a command while offline', () => {
    const { transport, device } = setup();
    assert.throws(() => device.set('acOutput', 1), DeviceOfflineError);
    transport.goOnline();
    assert.throws(() => device.set('acOutput', 1), DeviceOfflineError);
    assert.equal(transport.sets.length, 0);
  });

  it('sends a command, shows the new value at once, and accepts the confirmation', () => {
    const { transport, device, log, advance } = setup();
    transport.goOnline();
    transport.deliver(SN, 'data', display({ flow_info_ac_out: 2 }));

    device.set('acOutput', 0);
    assert.equal(transport.sets.length, 1);
    const sent = decodeSetCommand(transport.sets[0]!.payload);
    assert.deepEqual(sent?.command, { cfg_ac_out_open: 0 });
    assert.equal(sent?.header.device_sn, SN);
    assert.equal(device.isOn('acOutput'), false);

    transport.deliver(SN, 'data', display({ flow_info_ac_out: 0 }));
    advance(20_000);
    assert.equal(device.isOn('acOutput'), false);
    assert.equal(log.has('warn', 'did not confirm'), false);
  });

  it('goes back to the last known state when the unit does not confirm', () => {
    const { transport, device, log, updates, advance } = setup();
    transport.goOnline();
    transport.deliver(SN, 'data', display({ flow_info_ac_out: 2 }));
    device.set('acOutput', 0);
    assert.equal(device.isOn('acOutput'), false);
    const before = updates.count;
    advance(10_000);
    assert.equal(device.isOn('acOutput'), true);
    assert.equal(updates.count, before + 1);
    assert.ok(log.has('warn', 'did not confirm cfg_ac_out_open=0'));
  });

  it('lets the unit overrule a command it refused', () => {
    const { transport, device } = setup();
    transport.goOnline();
    transport.deliver(SN, 'data', display({ flow_info_12v: 0 }));
    device.set('dcOutput', 1);
    assert.equal(device.isOn('dcOutput'), true);
    transport.deliver(SN, 'data', display({ flow_info_12v: 0 }));
    assert.equal(device.isOn('dcOutput'), false);
  });

  it('sets the light mode', () => {
    const { transport, device } = setup();
    transport.goOnline();
    transport.deliver(SN, 'data', display({ led_mode: 0 }));
    device.set('ledMode', LED_MODE.bright);
    assert.deepEqual(decodeSetCommand(transport.sets[0]!.payload)?.command, { cfg_led_mode: 2 });
    assert.equal(device.ledMode, LED_MODE.bright);
    transport.deliver(
      SN,
      'set_reply',
      encode.envelope([{ cmdFunc: 254, cmdId: 18, pdata: encode.setReply({ config_ok: true, cfg_led_mode: 2 }) }]),
    );
    assert.equal(device.ledMode, LED_MODE.bright);
  });

  it('sets the maximum charge SOC', () => {
    const { transport, device } = setup();
    transport.goOnline();
    transport.deliver(SN, 'data', display({ cms_max_chg_soc: 100 }));
    device.set('maxChargeSoc', 80);
    assert.deepEqual(decodeSetCommand(transport.sets[0]!.payload)?.command, { cms_max_chg_soc: 80 });
  });

  it('survives a message it cannot decode', () => {
    const { transport, device } = setup();
    transport.goOnline();
    transport.deliver(SN, 'data', Buffer.from([0x0a, 0xff, 0xff, 0x01]));
    transport.deliver(SN, 'data', Buffer.alloc(0));
    transport.deliver(SN, 'data', display({ cms_batt_soc: 50 }));
    assert.equal(device.batteryLevel, 50);
  });

  it('stops listening and clears its timers', () => {
    const { transport, device, advance } = setup();
    transport.goOnline();
    device.stop();
    transport.deliver(SN, 'data', display({ cms_batt_soc: 50 }));
    advance(600_000);
    assert.equal(device.batteryLevel, undefined);
    assert.equal(transport.gets.length, 1);
  });
});
