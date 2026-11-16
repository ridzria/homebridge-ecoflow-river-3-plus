import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { EcoflowApiError, type EcoflowSession } from '../src/ecoflow/api.js';
import { CloudTransport, topicsFor, type MqttLike } from '../src/ecoflow/transport.js';
import { recordingLog } from './helpers.js';

class FakeMqtt extends EventEmitter {
  subscribed: string[] = [];
  published: Array<{ topic: string; payload: Buffer | string; qos: number }> = [];
  subscribeErrors = new Map<string, Error>();
  ended = false;

  subscribe(topics: string | string[], _options: { qos: number }, callback?: (error: Error | null) => void) {
    this.subscribed.push(...(Array.isArray(topics) ? topics : [topics]));
    const topic = Array.isArray(topics) ? topics[0] : topics;
    callback?.(topic === undefined ? null : this.subscribeErrors.get(topic) ?? null);
  }

  publish(topic: string, payload: Buffer | string, options: { qos: number }) {
    this.published.push({ topic, payload, qos: options.qos });
  }

  end() {
    this.ended = true;
  }
}

const session: EcoflowSession = {
  userId: '12345',
  userName: 'Someone',
  mqtt: { host: 'mqtt.example.test', port: 8883, username: 'app-user', password: 'app-pass' },
};
const credentials = { email: 'someone@example.com', password: 'secret', apiHost: 'api.example.test' };
const SN = 'R631TEST';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(loginImpl: () => Promise<EcoflowSession> = async () => session) {
  const log = recordingLog();
  const clients: FakeMqtt[] = [];
  const connects: Array<{ url: string; options: Record<string, unknown> }> = [];
  const logins = { count: 0 };
  const transport = new CloudTransport(credentials, log, {
    login: () => {
      logins.count++;
      return loginImpl();
    },
    connect: (url, options) => {
      connects.push({ url, options });
      const client = new FakeMqtt();
      clients.push(client);
      return client as unknown as MqttLike;
    },
  });
  transport.watch(SN);
  return { transport, log, clients, connects, logins };
}

describe('cloud transport', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('connects like the Android app and subscribes to the device topics', async () => {
    const { transport, clients, connects } = setup();
    let connected = 0;
    transport.on('connect', () => connected++);
    transport.start();
    await settle();

    assert.equal(connects[0]!.url, 'mqtts://mqtt.example.test:8883');
    assert.match(String(connects[0]!.options.clientId), /^ANDROID_[0-9A-F]{32}_12345$/);
    assert.equal(connects[0]!.options.username, 'app-user');
    assert.equal(connects[0]!.options.password, 'app-pass');
    assert.equal(transport.connected, false);

    clients[0]!.emit('connect');
    const topics = topicsFor('12345', SN);
    assert.deepEqual(clients[0]!.subscribed.sort(), [topics.data, topics.get_reply, topics.set_reply].sort());
    assert.equal(transport.connected, true);
    assert.equal(connected, 1);
  });

  it('routes incoming messages by serial number and channel', async () => {
    const { transport, clients } = setup();
    const seen: unknown[] = [];
    transport.on('message', (serialNumber, channel, payload) => seen.push([serialNumber, channel, payload.toString()]));
    transport.start();
    await settle();
    clients[0]!.emit('connect');

    const topics = topicsFor('12345', SN);
    clients[0]!.emit('message', topics.data, Buffer.from('a'));
    clients[0]!.emit('message', topics.set_reply, Buffer.from('b'));
    clients[0]!.emit('message', topics.get_reply, Buffer.from('c'));
    clients[0]!.emit('message', '/app/device/property/SOMEONE_ELSE', Buffer.from('d'));
    assert.deepEqual(seen, [
      [SN, 'data', 'a'],
      [SN, 'set_reply', 'b'],
      [SN, 'get_reply', 'c'],
    ]);
  });

  it('keeps accepted topics when EcoFlow refuses one topic', async () => {
    const { transport, clients, log } = setup();
    transport.start();
    await settle();

    const topics = topicsFor('12345', SN);
    clients[0]!.subscribeErrors.set(topics.data, new Error('Subscribe error: Unspecified error'));
    clients[0]!.emit('connect');

    assert.deepEqual(clients[0]!.subscribed.sort(), [topics.data, topics.get_reply, topics.set_reply].sort());
    assert.equal(transport.connected, true);
    assert.ok(log.has('warn', 'Could not subscribe to EcoFlow data topic'));
    assert.ok(!log.has('warn', 'Could not subscribe to EcoFlow set_reply topic'));
    assert.ok(!log.has('warn', 'Could not subscribe to EcoFlow get_reply topic'));
  });

  it('publishes commands only while connected', async () => {
    const { transport, clients } = setup();
    transport.start();
    await settle();
    assert.equal(transport.sendSet(SN, Buffer.from('x')), false);

    clients[0]!.emit('connect');
    assert.equal(transport.sendSet(SN, Buffer.from('x')), true);
    assert.equal(transport.sendGet(SN, '{}'), true);
    const topics = topicsFor('12345', SN);
    assert.deepEqual(
      clients[0]!.published.map((p) => [p.topic, p.qos]),
      [
        [topics.set, 1],
        [topics.get, 1],
      ],
    );
  });

  it('signs in again when the broker refuses the credentials', async () => {
    const { transport, clients, log, logins } = setup();
    let disconnected = 0;
    transport.on('disconnect', () => disconnected++);
    transport.start();
    await settle();
    clients[0]!.emit('connect');

    clients[0]!.emit('error', Object.assign(new Error('Not authorized'), { code: 5 }));
    assert.equal(clients[0]!.ended, true);
    assert.equal(transport.connected, false);
    assert.equal(disconnected, 1);
    assert.ok(log.has('warn', 'refused the broker credentials'));
    assert.equal(logins.count, 1);

    mock.timers.tick(30_000);
    await settle();
    assert.equal(logins.count, 2);
    assert.equal(clients.length, 2);
    clients[1]!.emit('connect');
    assert.equal(transport.connected, true);
  });

  it('reports a dropped connection and lets the client reconnect by itself', async () => {
    const { transport, clients, logins } = setup();
    let disconnected = 0;
    transport.on('disconnect', () => disconnected++);
    transport.start();
    await settle();
    clients[0]!.emit('connect');
    clients[0]!.emit('close');
    assert.equal(transport.connected, false);
    assert.equal(disconnected, 1);
    clients[0]!.emit('connect');
    assert.equal(transport.connected, true);
    assert.equal(logins.count, 1);
    assert.equal(clients.length, 1);
  });

  it('does not retry a rejected password', async () => {
    const { transport, clients, log, logins } = setup(async () => {
      throw new EcoflowApiError('EcoFlow sign-in was refused by EcoFlow: wrong password', true, '2026');
    });
    transport.start();
    await settle();
    assert.ok(log.has('error', 'Check the email, password and EcoFlow region'));
    mock.timers.tick(24 * 60 * 60_000);
    await settle();
    assert.equal(logins.count, 1);
    assert.equal(clients.length, 0);
  });

  it('retries a temporary sign-in failure with a growing delay', async () => {
    let fail = true;
    const { transport, clients, logins } = setup(async () => {
      if (fail) {
        throw new EcoflowApiError('EcoFlow sign-in failed with HTTP 503', false);
      }
      return session;
    });
    transport.start();
    await settle();
    assert.equal(logins.count, 1);

    mock.timers.tick(29_000);
    await settle();
    assert.equal(logins.count, 1);
    mock.timers.tick(1_000);
    await settle();
    assert.equal(logins.count, 2);

    mock.timers.tick(59_000);
    await settle();
    assert.equal(logins.count, 2);
    fail = false;
    mock.timers.tick(1_000);
    await settle();
    assert.equal(logins.count, 3);
    assert.equal(clients.length, 1);
  });

  it('stops cleanly', async () => {
    const { transport, clients, logins } = setup();
    transport.start();
    await settle();
    clients[0]!.emit('connect');
    transport.stop();
    assert.equal(clients[0]!.ended, true);
    assert.equal(transport.connected, false);
    mock.timers.tick(60 * 60_000);
    await settle();
    assert.equal(logins.count, 1);
  });
});
