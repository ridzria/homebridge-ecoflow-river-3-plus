#!/usr/bin/env node
/**
 * Connect to EcoFlow without Homebridge and print what a RIVER 3 reports.
 * Handy for checking a new unit, or for collecting details for a bug report.
 *
 *   npm run build
 *   ECOFLOW_EMAIL=you@example.com ECOFLOW_PASSWORD='...' ECOFLOW_SN=R631... npm run probe
 *
 * Optional: ECOFLOW_HOST=api-e.ecoflow.com (Europe), PROBE_SECONDS=120.
 * It only listens. It never changes a setting on the unit.
 */
import { River3Device } from '../dist/ecoflow/device.js';
import { CloudTransport } from '../dist/ecoflow/transport.js';

const { ECOFLOW_EMAIL: email, ECOFLOW_PASSWORD: password, ECOFLOW_SN: serial } = process.env;
if (!email || !password || !serial) {
  console.error('Set ECOFLOW_EMAIL, ECOFLOW_PASSWORD and ECOFLOW_SN first. See the top of this file.');
  process.exit(1);
}
const seconds = Number(process.env.PROBE_SECONDS ?? 90);
const stamp = () => new Date().toISOString().slice(11, 19);
const log = {
  info: (message) => console.log(stamp(), message),
  warn: (message) => console.log(stamp(), 'WARN', message),
  error: (message) => console.log(stamp(), 'ERROR', message),
  debug: (message) => console.log(stamp(), '  ', message),
};

const transport = new CloudTransport(
  { email, password, apiHost: process.env.ECOFLOW_HOST ?? 'api.ecoflow.com' },
  log,
);
const device = new River3Device(serial.trim().toUpperCase(), transport, log);
device.on('update', () => {
  console.log(
    stamp(),
    `online=${device.online} battery=${device.batteryLevel ?? '?'}% charging=${device.charging}`,
    `mains=${device.mainsConnected ?? '?'} ac=${device.isOn('acOutput')} (${device.acOutputWatts} W)`,
    `12v=${device.isOn('dcOutput')} (${device.dcOutputWatts} W) xboost=${device.isOn('xboost')} light=${device.ledMode}`,
    `in=${device.inputWatts} W out=${device.outputWatts} W`,
  );
});
device.start();
transport.start();
console.log(`Listening for ${seconds} seconds. Change something in the EcoFlow app to see it arrive here.`);
setTimeout(() => {
  device.stop();
  transport.stop();
  process.exit(0);
}, seconds * 1000);
