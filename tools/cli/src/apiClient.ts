// HTTP client for the device control API (firmware/components/control_api). Uses Node 22's global
// fetch. A device is addressed by either an mDNS hostname (rf-sense-a1b2.local) or a direct IP --
// we never depend on mDNS alone, so --host always works as a fallback.
export interface DeviceTarget {
  baseUrl: string;
  timeoutMs?: number;
}

// Accepts a bare host (rf-sense-a1b2.local / 192.168.1.50), host:port, or a full URL.
export function resolveBaseUrl(hostOrUrl: string): string {
  if (/^https?:\/\//.test(hostOrUrl)) return hostOrUrl;
  return `http://${hostOrUrl}`;
}

export interface ApiResponse {
  status: number;
  json: unknown;
}

export async function apiCall(
  target: DeviceTarget,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  const url = new URL(`/api/v1${path}`, target.baseUrl).toString();
  const headers: Record<string, string> = {};
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

export function requireHost(flags: Map<string, string>): DeviceTarget {
  const host = flags.get('host') ?? process.env.RF_SENSE_DEVICE;
  if (!host) {
    console.error('error: provide --host <hostname-or-ip> (or set RF_SENSE_DEVICE)');
    process.exit(2);
  }
  return { baseUrl: resolveBaseUrl(host) };
}
