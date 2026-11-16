import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Transport, TransportLog } from '../src/ecoflow/transport.js';

export interface RecordingLog extends TransportLog {
  lines: Array<{ level: string; message: string }>;
  has(level: string, text: string): boolean;
}

export function recordingLog(): RecordingLog {
  const lines: Array<{ level: string; message: string }> = [];
  const add = (level: string) => (message: string) => void lines.push({ level, message });
  return {
    lines,
    info: add('info'),
    warn: add('warn'),
    error: add('error'),
    debug: add('debug'),
    has: (level, text) => lines.some((line) => line.level === level && line.message.includes(text)),
  };
}

/** A transport that records what is sent and lets a test deliver messages by hand. */
export class FakeTransport extends EventEmitter implements Transport {
  connected = false;
  readonly watched: string[] = [];
  readonly sets: Array<{ serialNumber: string; payload: Buffer }> = [];
  readonly gets: Array<{ serialNumber: string; payload: string }> = [];

  watch(serialNumber: string): void {
    this.watched.push(serialNumber);
  }

  start(): void {
    this.goOnline();
  }

  stop(): void {
    this.goOffline();
  }

  goOnline(): void {
    this.connected = true;
    this.emit('connect');
  }

  goOffline(): void {
    this.connected = false;
    this.emit('disconnect');
  }

  sendSet(serialNumber: string, payload: Buffer): boolean {
    if (!this.connected) {
      return false;
    }
    this.sets.push({ serialNumber, payload });
    return true;
  }

  sendGet(serialNumber: string, payload: string): boolean {
    if (!this.connected) {
      return false;
    }
    this.gets.push({ serialNumber, payload });
    return true;
  }

  deliver(serialNumber: string, channel: 'data' | 'set_reply' | 'get_reply', payload: Buffer): void {
    this.emit('message', serialNumber, channel, payload);
  }
}

export interface ReferenceFixtures {
  source: string;
  commands: Array<{ field: string; value: number; seq: number; sn: string; hex: string }>;
  telemetry: Array<{ name: string; hex: string; expected: Record<string, unknown> }>;
}

export function referenceFixtures(): ReferenceFixtures {
  return JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', 'reference.json'), 'utf8')) as ReferenceFixtures;
}
