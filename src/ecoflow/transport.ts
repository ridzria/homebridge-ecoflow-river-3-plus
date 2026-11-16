import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import mqtt from 'mqtt';

import { EcoflowApiError, login, type EcoflowCredentials, type EcoflowSession } from './api.js';

export type Channel = 'data' | 'set_reply' | 'get_reply';

export interface TransportLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/**
 * The link between devices and EcoFlow. Emits:
 *  - 'message' (serialNumber, channel, payload)
 *  - 'connect' and 'disconnect'
 */
export interface Transport extends EventEmitter {
  readonly connected: boolean;
  /** Register a device before start(). */
  watch(serialNumber: string): void;
  start(): void;
  stop(): void;
  /** Returns false when the message could not be sent because there is no connection. */
  sendSet(serialNumber: string, payload: Buffer): boolean;
  sendGet(serialNumber: string, payload: string): boolean;
}

/** The slice of an MQTT client this transport uses, so tests can supply a fake. */
export interface MqttLike {
  on(event: 'connect', listener: () => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error & { code?: number | string }) => void): this;
  on(event: 'message', listener: (topic: string, payload: Buffer) => void): this;
  subscribe(topics: string | string[], options: { qos: 0 | 1 | 2 }, callback?: (error: Error | null) => void): unknown;
  publish(topic: string, payload: Buffer | string, options: { qos: 0 | 1 | 2 }): unknown;
  end(force?: boolean): unknown;
}

export interface CloudTransportDeps {
  login: (credentials: EcoflowCredentials) => Promise<EcoflowSession>;
  connect: (url: string, options: Record<string, unknown>) => MqttLike;
}

const defaultDeps: CloudTransportDeps = {
  login: (credentials) => login(credentials),
  connect: (url, options) => mqtt.connect(url, options) as unknown as MqttLike,
};

const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 15 * 60_000;
/** MQTT 3.1.1 CONNACK codes: 4 = bad user name or password, 5 = not authorised. */
const MQTT_AUTH_CODES = new Set([4, 5]);

export function topicsFor(userId: string, serialNumber: string) {
  return {
    data: `/app/device/property/${serialNumber}`,
    set: `/app/${userId}/${serialNumber}/thing/property/set`,
    set_reply: `/app/${userId}/${serialNumber}/thing/property/set_reply`,
    get: `/app/${userId}/${serialNumber}/thing/property/get`,
    get_reply: `/app/${userId}/${serialNumber}/thing/property/get_reply`,
  };
}

/** Connects to EcoFlow's cloud MQTT broker the same way the phone app does. */
export class CloudTransport extends EventEmitter implements Transport {
  private readonly serialNumbers = new Set<string>();
  private readonly topicIndex = new Map<string, { serialNumber: string; channel: Channel }>();
  private session?: EcoflowSession;
  private client?: MqttLike;
  private retryTimer?: NodeJS.Timeout;
  private retryDelay = FIRST_RETRY_MS;
  private stopped = true;
  private isConnected = false;

  constructor(
    private readonly credentials: EcoflowCredentials,
    private readonly log: TransportLog,
    private readonly deps: CloudTransportDeps = defaultDeps,
  ) {
    super();
  }

  get connected(): boolean {
    return this.isConnected;
  }

  watch(serialNumber: string): void {
    this.serialNumbers.add(serialNumber);
  }

  start(): void {
    this.stopped = false;
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.closeClient();
  }

  sendSet(serialNumber: string, payload: Buffer): boolean {
    return this.publish(serialNumber, 'set', payload);
  }

  sendGet(serialNumber: string, payload: string): boolean {
    return this.publish(serialNumber, 'get', payload);
  }

  private publish(serialNumber: string, kind: 'set' | 'get', payload: Buffer | string): boolean {
    if (!this.client || !this.session || !this.isConnected) {
      return false;
    }
    this.client.publish(topicsFor(this.session.userId, serialNumber)[kind], payload, { qos: 1 });
    return true;
  }

  /** Sign in, then connect. Any failure schedules another attempt, except rejected credentials. */
  private async open(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      this.session = await this.deps.login(this.credentials);
    } catch (error) {
      if (error instanceof EcoflowApiError && error.rejected) {
        // Retrying a refused password risks locking the account, so stop here.
        this.log.error(
          `${error.message}. Check the email, password and EcoFlow region in the plugin settings (European accounts need the Europe region), then restart Homebridge.`,
        );
        return;
      }
      this.retryLater(`Could not sign in to EcoFlow (${(error as Error).message})`);
      return;
    }
    if (this.stopped) {
      return;
    }
    this.log.info('Signed in to EcoFlow, connecting to its message broker');
    this.connect(this.session);
  }

  private connect(session: EcoflowSession): void {
    this.topicIndex.clear();
    for (const serialNumber of this.serialNumbers) {
      const topics = topicsFor(session.userId, serialNumber);
      this.topicIndex.set(topics.data, { serialNumber, channel: 'data' });
      this.topicIndex.set(topics.set_reply, { serialNumber, channel: 'set_reply' });
      this.topicIndex.set(topics.get_reply, { serialNumber, channel: 'get_reply' });
    }

    const client = this.deps.connect(`mqtts://${session.mqtt.host}:${session.mqtt.port}`, {
      // The broker only accepts client ids shaped like the Android app's.
      clientId: `ANDROID_${randomUUID().replaceAll('-', '').toUpperCase()}_${session.userId}`,
      username: session.mqtt.username,
      password: session.mqtt.password,
      protocolVersion: 4,
      clean: true,
      keepalive: 15,
      connectTimeout: 30_000,
      reconnectPeriod: 10_000,
      rejectUnauthorized: true,
    });
    this.client = client;

    client.on('connect', () => {
      if (client !== this.client) {
        return;
      }
      this.isConnected = true;
      this.retryDelay = FIRST_RETRY_MS;
      for (const [topic, target] of this.topicIndex) {
        client.subscribe(topic, { qos: 1 }, (error) => {
          if (error) {
            this.log.warn(`Could not subscribe to EcoFlow ${target.channel} topic: ${error.message}`);
          }
        });
      }
      this.log.info('Connected to EcoFlow');
      this.emit('connect');
    });

    client.on('close', () => {
      if (client !== this.client || !this.isConnected) {
        return;
      }
      this.isConnected = false;
      this.log.warn('Connection to EcoFlow lost, reconnecting');
      this.emit('disconnect');
    });

    client.on('error', (error) => {
      if (client !== this.client) {
        return;
      }
      if (MQTT_AUTH_CODES.has(Number(error.code))) {
        // The broker credentials expire. Stop the client's own retries and sign in again.
        this.closeClient();
        this.retryLater('EcoFlow refused the broker credentials');
        return;
      }
      this.log.debug(`EcoFlow connection error: ${error.message}`);
    });

    client.on('message', (topic, payload) => {
      const target = this.topicIndex.get(topic);
      if (target) {
        this.emit('message', target.serialNumber, target.channel, payload);
      }
    });
  }

  private closeClient(): void {
    const client = this.client;
    this.client = undefined;
    if (client) {
      client.end(true);
    }
    if (this.isConnected) {
      this.isConnected = false;
      this.emit('disconnect');
    }
  }

  private retryLater(reason: string): void {
    if (this.stopped) {
      return;
    }
    const seconds = Math.round(this.retryDelay / 1000);
    this.log.warn(`${reason}. Trying again in ${seconds} seconds.`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.open(), this.retryDelay);
    this.retryTimer.unref();
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
  }
}
