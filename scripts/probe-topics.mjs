#!/usr/bin/env node
/**
 * Diagnose EcoFlow MQTT topic permissions and inspect received payloads.
 *
 * Required environment variables:
 *   ECOFLOW_EMAIL, ECOFLOW_PASSWORD, ECOFLOW_SN
 * Optional:
 *   ECOFLOW_HOST=api-e.ecoflow.com
 *   PROBE_SECONDS=30
 *
 * This script never prints credentials, MQTT credentials, user IDs, or the
 * serial number. It subscribes to each topic separately so a rejected topic
 * can be identified, then prints only payload size and hex.
 */
import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';

import { login } from '../dist/ecoflow/api.js';
import { buildQuotaRequest } from '../dist/ecoflow/protocol.js';
import { topicsFor } from '../dist/ecoflow/transport.js';

const { ECOFLOW_EMAIL: email, ECOFLOW_PASSWORD: password, ECOFLOW_SN: serial } = process.env;
if (!email || !password || !serial) {
  console.error('Set ECOFLOW_EMAIL, ECOFLOW_PASSWORD and ECOFLOW_SN first.');
  process.exit(1);
}

const seconds = Number(process.env.PROBE_SECONDS ?? 30);
const apiHost = process.env.ECOFLOW_HOST ?? 'api-e.ecoflow.com';

const session = await login({ email, password, apiHost });
const topics = topicsFor(session.userId, serial.trim().toUpperCase());
const topicNames = [
  ['data', topics.data],
  ['get', topics.get],
  ['set_reply', topics.set_reply],
  ['get_reply', topics.get_reply],
];
const nameByTopic = new Map(topicNames);

function topicLabel(topic) {
  const exact = nameByTopic.get(topic);
  if (exact) {
    return exact;
  }
  const suffix = '/thing/property/';
  const index = topic.lastIndexOf(suffix);
  return index >= 0 ? `property/${topic.slice(index + suffix.length)}` : 'unknown';
}

const client = mqtt.connect(`mqtts://${session.mqtt.host}:${session.mqtt.port}`, {
  clientId: `ANDROID_${randomUUID().replaceAll('-', '').toUpperCase()}_${session.userId}`,
  username: session.mqtt.username,
  password: session.mqtt.password,
  protocolVersion: 4,
  clean: true,
  keepalive: 15,
  connectTimeout: 30_000,
  rejectUnauthorized: true,
});

client.on('error', (error) => {
  console.error(`MQTT error: ${error.message}`);
});

client.on('message', (topic, payload) => {
  const name = topicLabel(topic);
  console.log(`${name}: ${payload.length} bytes hex=${payload.toString('hex')}`);
});

client.on('connect', async () => {
  console.log(`Connected. Testing ${topicNames.length} subscriptions for ${seconds} seconds.`);

  for (const [name, topic] of topicNames) {
    await new Promise((resolve) => {
      client.subscribe(topic, { qos: 1 }, (error, granted) => {
        if (error) {
          console.log(`${name}: ERROR code=${error.code ?? '?'} ${error.message}`);
        } else {
          console.log(`${name}: OK ${JSON.stringify(granted)}`);
        }
        resolve();
      });
    });
  }

  // Request the same read-only latest-quota snapshot used by the plugin.
  client.publish(topics.get, buildQuotaRequest(), { qos: 1 });
  console.log('latestQuotas request sent');
});

setTimeout(() => client.end(true), seconds * 1000);
