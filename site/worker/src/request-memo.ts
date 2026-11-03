/** GO-KM-D1-SCANS §2: one load per request.
 *
 * Several loaders are needed by more than one part of the same response (a /check body needs tips for the community block
 * AND for the experience aggregate; /chart reads the same flag cache twice). Every such load is a full-table read in D1,
 * so the second one is pure waste. This module keeps one map per request: the first caller loads, the rest await the same
 * promise. The map is dropped when the request ends, so nothing survives into a later request.
 *
 * It is deliberately NOT a time-based isolate cache: a write inside the request (refreshFlagCache) forgets its own keys.
 * A nested router call (/merchant -> /records, / -> /llms.txt) gets its own scope and hands it back on the way out.
 */
const stack: Map<string, Promise<unknown>>[] = []; // one entry per open request scope; the top one is the current request

/** Open a request scope. Always pair with endRequestMemo() in a finally block. */
export function beginRequestMemo(): void { stack.push(new Map()); }

/** Close the innermost scope (the caller's scope, if any, is untouched). */
export function endRequestMemo(): void { stack.pop(); }

/** Current scope, or null outside a request (unit tests, cron, DO alarm). */
function scope(): Map<string, Promise<unknown>> | null { return stack.length ? stack[stack.length - 1]! : null; }

/** Run `load` once per request for `key` and share the result, including with callers that arrive while it is in flight. */
export function memoLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
  const m = scope();
  if (!m) return load();
  const hit = m.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const p = load();
  m.set(key, p as Promise<unknown>);
  // a failed load must not poison the rest of the request
  p.catch(() => { if (m.get(key) === (p as unknown as Promise<unknown>)) m.delete(key); });
  return p;
}

/** Forget a key, or every key with this prefix, after a write in the same request. */
export function memoForget(prefix: string): void {
  const m = scope();
  if (!m) return;
  for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
}

/** How many loads this request has memoized so far (tests assert no duplicate scans). */
export function memoSize(): number { return scope()?.size ?? 0; }
