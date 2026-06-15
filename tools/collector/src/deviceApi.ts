// Minimal client for the device control API (firmware/components/control_api). Uses the global
// fetch shipped with Node 22. The admin token authorizes mutating endpoints.
export interface DeviceApiOptions {
  baseUrl: string; // e.g. http://rf-sense-a1b2.local  or  http://192.168.1.50
  token?: string;
  timeoutMs?: number;
}

async function call(
  opts: DeviceApiOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const url = new URL(`/api/v1${path}`, opts.baseUrl).toString();
  const headers: Record<string, string> = {};
  if (opts.token) headers['X-Device-Token'] = opts.token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

export const deviceApi = {
  status: (o: DeviceApiOptions) => call(o, 'GET', '/status'),
  health: (o: DeviceApiOptions) => call(o, 'GET', '/health'),
  config: (o: DeviceApiOptions) => call(o, 'GET', '/config'),
  setConfig: (o: DeviceApiOptions, cfg: Record<string, unknown>) => call(o, 'POST', '/config', cfg),
  startCapture: (o: DeviceApiOptions) => call(o, 'POST', '/capture/start'),
  stopCapture: (o: DeviceApiOptions) => call(o, 'POST', '/capture/stop'),
  otaCheck: (o: DeviceApiOptions) => call(o, 'POST', '/ota/check'),
  otaApply: (o: DeviceApiOptions) => call(o, 'POST', '/ota/apply'),
  reboot: (o: DeviceApiOptions) => call(o, 'POST', '/reboot'),
  provisioningReset: (o: DeviceApiOptions) => call(o, 'POST', '/provisioning/reset'),
};
