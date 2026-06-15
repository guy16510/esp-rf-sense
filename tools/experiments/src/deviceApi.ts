// Device control API client (Node 22 global fetch). Mirrors the collector/cli clients; kept local
// so each workspace stays independently buildable.
export interface DeviceTarget {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

export function resolveBaseUrl(hostOrUrl: string): string {
  return /^https?:\/\//.test(hostOrUrl) ? hostOrUrl : `http://${hostOrUrl}`;
}

export async function apiCall(
  target: DeviceTarget,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const url = new URL(`/api/v1${path}`, target.baseUrl).toString();
  const headers: Record<string, string> = {};
  if (target.token) headers['X-Device-Token'] = target.token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs ?? 8000);
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
