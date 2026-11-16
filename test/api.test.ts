import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EcoflowApiError, login, type FetchLike } from '../src/ecoflow/api.js';

const credentials = { email: 'someone@example.com', password: 'p@ss wörd', apiHost: 'api.example.test' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const goodLogin = { message: 'Success', data: { token: 'TOKEN', user: { userId: '12345', name: 'Someone' } } };
const goodCert = {
  message: 'Success',
  data: { url: 'mqtt.example.test', port: '8883', certificateAccount: 'app-user', certificatePassword: 'app-pass' },
};

describe('EcoFlow sign-in', () => {
  it('signs in, then fetches MQTT credentials with the token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1 ? json(goodLogin) : json(goodCert);
    };
    const session = await login(credentials, fetchImpl);

    assert.deepEqual(session, {
      userId: '12345',
      userName: 'Someone',
      mqtt: { host: 'mqtt.example.test', port: 8883, username: 'app-user', password: 'app-pass' },
    });
    assert.equal(calls[0]!.url, 'https://api.example.test/auth/login');
    assert.equal(calls[0]!.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      email: 'someone@example.com',
      password: Buffer.from('p@ss wörd', 'utf8').toString('base64'),
      scene: 'IOT_APP',
      userType: 'ECOFLOW',
    });
    assert.equal(calls[1]!.url, 'https://api.example.test/iot-auth/app/certification?userId=12345');
    assert.equal((calls[1]!.init.headers as Record<string, string>).authorization, 'Bearer TOKEN');
  });

  it('marks a refused sign-in as rejected, so it is not retried', async () => {
    const fetchImpl: FetchLike = async () => json({ code: '2026', message: 'Incorrect account or password' });
    await assert.rejects(login(credentials, fetchImpl), (error: unknown) => {
      assert.ok(error instanceof EcoflowApiError);
      assert.equal(error.rejected, true);
      assert.equal(error.code, '2026');
      assert.ok(!error.message.includes(credentials.password));
      return true;
    });
  });

  it('treats a server error as temporary', async () => {
    const fetchImpl: FetchLike = async () => json({}, 503);
    await assert.rejects(login(credentials, fetchImpl), (error: unknown) => {
      assert.ok(error instanceof EcoflowApiError);
      assert.equal(error.rejected, false);
      return true;
    });
  });

  it('treats a refused credentials request as temporary', async () => {
    let call = 0;
    const fetchImpl: FetchLike = async () => (++call === 1 ? json(goodLogin) : json({ code: '500', message: 'busy' }));
    await assert.rejects(login(credentials, fetchImpl), (error: unknown) => {
      assert.ok(error instanceof EcoflowApiError);
      assert.equal(error.rejected, false);
      return true;
    });
  });

  it('reports a response with missing fields', async () => {
    const fetchImpl: FetchLike = async () => json({ message: 'Success', data: { user: { userId: '1' } } });
    await assert.rejects(login(credentials, fetchImpl), /missing "token"/);
  });
});
