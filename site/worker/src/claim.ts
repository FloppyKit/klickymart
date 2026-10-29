const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.|::1|\[::1\])/i;

export function validateClaimDomain(input: string): { ok: true; domain: string } | { ok: false; message: string } {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return { ok: false, message: "domain required" };
  if (trimmed.includes("://")) return { ok: false, message: "do not include a scheme" };
  if (trimmed.includes("/")) return { ok: false, message: "domain only, no path" };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(trimmed)) return { ok: false, message: "IP addresses not allowed" };
  if (PRIVATE_HOST_RE.test(trimmed)) return { ok: false, message: "private hostnames not allowed" };
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)) {
    return { ok: false, message: "invalid domain" };
  }
  return { ok: true, domain: trimmed };
}

export interface NostrJsonResult {
  ok: boolean;
  status: number;
  cors: boolean;
  names: Record<string, string>;
  underscore?: string;
  error?: string;
  raw?: string;
}

export async function fetchNostrJson(domain: string, timeoutMs = 5000): Promise<NostrJsonResult> {
  const url = `https://${domain}/.well-known/nostr.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("Location");
      if (loc && !loc.includes(domain)) {
        return { ok: false, status: res.status, cors: false, names: {}, error: "redirect to other host" };
      }
    }
    const cors = res.headers.get("Access-Control-Allow-Origin") === "*"
      || res.headers.get("Access-Control-Allow-Origin")?.includes("*") === true;
    const text = await res.text();
    if (text.length > 65536) {
      return { ok: false, status: res.status, cors, names: {}, error: "response too large" };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, cors, names: {}, error: `HTTP ${res.status}` };
    }
    let data: { names?: Record<string, string> };
    try {
      data = JSON.parse(text) as { names?: Record<string, string> };
    } catch {
      return { ok: false, status: res.status, cors, names: {}, error: "invalid JSON", raw: text.slice(0, 200) };
    }
    const names = data.names ?? {};
    return {
      ok: true,
      status: res.status,
      cors,
      names,
      underscore: names._,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    return { ok: false, status: 0, cors: false, names: {}, error: msg.includes("abort") ? "timeout" : msg };
  } finally {
    clearTimeout(timer);
  }
}

/** hex to npub bech32 simplified — use minimal encoder for tests */
export function hexToNpub(hex: string): string {
  if (hex.length !== 64) return hex;
  return `npub1${hex.slice(0, 8)}…${hex.slice(-4)}`;
}
