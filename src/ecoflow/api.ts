/**
 * EcoFlow app ("private") API: sign in with the app's email and password,
 * then fetch the MQTT credentials the app itself uses.
 */

export interface EcoflowCredentials {
  email: string;
  password: string;
  /** For example api.ecoflow.com, api-s.ecoflow.com (EcoFlow app service), api-e.ecoflow.com (Europe) or api-a.ecoflow.com (Americas). */
  apiHost: string;
}

export interface MqttCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface EcoflowSession {
  userId: string;
  userName: string;
  mqtt: MqttCredentials;
}

export class EcoflowApiError extends Error {
  constructor(
    message: string,
    /** True when EcoFlow rejected the credentials, so retrying with the same ones cannot work. */
    readonly rejected: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'EcoflowApiError';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 20_000;

async function readJson(response: Response, what: string, rejectOnCode: boolean): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new EcoflowApiError(`${what} failed with HTTP ${response.status}`, false);
  }
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new EcoflowApiError(`${what} returned a response that is not JSON`, false);
  }
  const message = typeof body.message === 'string' ? body.message : '';
  if (message.toLowerCase() !== 'success') {
    const code = body.code === undefined || body.code === null ? undefined : String(body.code);
    // An error code from the login call means EcoFlow understood the request and refused it.
    throw new EcoflowApiError(`${what} was refused by EcoFlow: ${message || 'no message'}`, rejectOnCode && code !== undefined, code);
  }
  return body;
}

function field(source: unknown, key: string, what: string): unknown {
  const value = (source as Record<string, unknown> | undefined)?.[key];
  if (value === undefined || value === null || value === '') {
    throw new EcoflowApiError(`${what} response is missing "${key}"`, false);
  }
  return value;
}

/** Sign in and fetch MQTT credentials. Never logs or returns the account password. */
export async function login(credentials: EcoflowCredentials, fetchImpl: FetchLike = fetch): Promise<EcoflowSession> {
  const base = `https://${credentials.apiHost}`;

  const loginResponse = await fetchImpl(`${base}/auth/login`, {
    method: 'POST',
    headers: { lang: 'en_US', 'content-type': 'application/json' },
    body: JSON.stringify({
      email: credentials.email,
      password: Buffer.from(credentials.password, 'utf8').toString('base64'),
      scene: 'IOT_APP',
      userType: 'ECOFLOW',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const loginBody = await readJson(loginResponse, 'EcoFlow sign-in', true);
  const token = String(field(loginBody.data, 'token', 'Sign-in'));
  const user = field(loginBody.data, 'user', 'Sign-in');
  const userId = String(field(user, 'userId', 'Sign-in'));
  const userName = String((user as Record<string, unknown>).name ?? '');

  const certResponse = await fetchImpl(`${base}/iot-auth/app/certification?userId=${encodeURIComponent(userId)}`, {
    method: 'GET',
    headers: { lang: 'en_US', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const certBody = await readJson(certResponse, 'EcoFlow MQTT credentials request', false);
  const what = 'MQTT credentials';
  return {
    userId,
    userName,
    mqtt: {
      host: String(field(certBody.data, 'url', what)),
      port: Number(field(certBody.data, 'port', what)),
      username: String(field(certBody.data, 'certificateAccount', what)),
      password: String(field(certBody.data, 'certificatePassword', what)),
    },
  };
}
