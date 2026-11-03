/** GO-KM-D1-SCANS §2: one load per request.
 *
 * Several loaders are needed by more than one part of the same response (a /check body needs tips for the community block
 * AND for the experience aggregate; /chart reads the same flag cache twice). Every such load is a full-table read in D1,
 * so the second one is pure waste. This module keeps one map per request: the first caller loads, the rest await the same
 * promise. The map is dropped when the request ends, so nothing survives into a later request.
 *
 * F1 B5: the scope is an AsyncLocalStorage store, not a module-level stack. Two requests interleaved in one isolate can no
 * longer read or pop each other's scope (the stack version leaked: whoever resumed last saw the other request's map).
 * A nested router call (/merchant -> /records, / -> /llms.txt) runs in its own store and hands the outer one back on the
 * way out, exactly like a nested `run()` should.
 *
 * It is deliberately NOT a time-based isolate cache: a write inside the request (refreshFlagCache) forgets its own keys.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type Memo = Map<string, Promise<unknown>>;
const als = new AsyncLocalStorage<Memo>();

/** Run `fn` inside a fresh request scope. The scope dies with it; concurrent requests never share one. */
export function withRequestMemoScope<T>(fn: () => Promise<T>): Promise<T> {
  return als.run(new Map<string, Promise<unknown>>(), fn);
}

/** Current scope, or undefined outside a request (unit tests, cron, DO alarm). */
function scope(): Memo | undefined { return als.getStore(); }

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
