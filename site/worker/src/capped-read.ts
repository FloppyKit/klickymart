/** Read a response body as UTF-8, or null as soon as it exceeds max bytes (the rest is cancelled, not buffered). */
export async function readCapped(r: Response, max: number): Promise<string | null> {
  const cl = Number(r.headers.get("content-length")); if (Number.isFinite(cl) && cl > max) { try { await r.body?.cancel(); } catch { /* */ } return null; }
  if (!r.body) return "";
  const reader = r.body.getReader(); const parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    n += value.byteLength; if (n > max) { try { await reader.cancel(); } catch { /* */ } return null; }
    parts.push(value);
  }
  const all = new Uint8Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}
