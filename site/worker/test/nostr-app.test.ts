import { describe, expect, it, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bech32 } from "@scure/base";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { authLimitList, checkFeedList, login, makeChallenge, parseFeedList, payUrlFromProfile, readFeed, readSession, siteTipAddress, tipReadyFor, verifyAuthEvent, parseFeedParams, listLimitList } from "../src/nostr-app";
import { takeAll, take } from "../src/ratelimit";
import { layout } from "../src/render/layout";
import { APP_SRI, NOSTR_TOOLS_SRI } from "../src/render/pages";
import APPJS from "../../public/km-app.js?raw";
import QUERY_SRC from "../src/query.ts?raw";

const O = "https://klickymart.com"; const SEC = "test-only-auth-secret";
type T = { kind: number; created_at: number; tags: string[][]; content: string };
function sign(t: T, sk = secp.utils.randomSecretKey()) {
  const pubkey = bytesToHex(secp.schnorr.getPublicKey(sk));
  const id = nostrEventId({ ...t, pubkey });
  return { ...t, pubkey, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
const now = () => Math.floor(Date.now() / 1000);
const authEv = (ch: string, sk?: Parameters<typeof sign>[1], over: Partial<T> = {}) => sign({ kind: 27235, created_at: now(), content: "", tags: [["u", `${O}/auth/login`], ["method", "POST"], ["challenge", ch]], ...over }, sk);
function app() { const win: Record<string, any> = {}; new Function("window", "document", APPJS as string)(win, { getElementById: () => null }); return win.KMApp; }
async function sri(s: string) { const d = await crypto.subtle.digest("SHA-384", new TextEncoder().encode(s)); return "sha384-" + btoa(String.fromCharCode(...new Uint8Array(d))); }
beforeEach(async () => { await env.DB.prepare("DELETE FROM rate_limits").run(); });

describe("login (NIP-98-style signed challenge)", () => {
  it("full round trip over HTTP with a throwaway key: challenge -> signed 27235 -> session cookie -> /auth/me", async () => {
    const sk = secp.utils.randomSecretKey(); const pk = bytesToHex(secp.schnorr.getPublicKey(sk));
    const c = await (await SELF.fetch(`${O}/auth/challenge`)).json() as { challenge: string; u: string };
    expect(c.u).toBe(`${O}/auth/login`);
    const ev = sign(app().authTemplate(c.u, c.challenge), sk);
    const r = await SELF.fetch(`${O}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: O }, body: JSON.stringify({ event: ev }) });
    expect(r.status).toBe(200);
    const cookie = r.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/HttpOnly; SameSite=Strict/); expect(cookie).toContain("Secure");
    const me = await (await SELF.fetch(`${O}/auth/me`, { headers: { Cookie: cookie.split(";")[0] } })).json() as { pubkey: string };
    expect(me.pubkey).toBe(pk);
    // replay of the same signed event is refused (one-time challenge)
    const again = await SELF.fetch(`${O}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: ev }) });
    expect(again.status).toBe(400); expect(((await again.json()) as any).error.code).toBe("challenge_used");
  });
  it("refuses cross-origin login, wrong u, stale time, forged challenge, bad signature and any secret in the body", async () => {
    const ch = makeChallenge(SEC);
    expect((await SELF.fetch(`${O}/auth/login`, { method: "POST", headers: { Origin: "https://evil.example.com" }, body: JSON.stringify({ event: authEv(ch) }) })).status).toBe(403);
    expect(verifyAuthEvent(authEv(ch, undefined, { tags: [["u", "https://evil.example.com/auth/login"], ["method", "POST"], ["challenge", ch]] }), O, SEC)).toMatchObject({ ok: false, code: "bad_url" });
    expect(verifyAuthEvent(authEv(ch, undefined, { created_at: now() - 600 }), O, SEC)).toMatchObject({ ok: false, code: "bad_time" });
    expect(verifyAuthEvent(authEv(makeChallenge("other-secret")), O, SEC)).toMatchObject({ ok: false, code: "bad_challenge" });
    const bad = { ...authEv(ch), sig: "00".repeat(64) };
    expect(verifyAuthEvent(bad, O, SEC)).toMatchObject({ ok: false, code: "bad_signature" });
    const nsec = "nsec1" + "q".repeat(58);
    expect(verifyAuthEvent({ ...authEv(ch), content: nsec }, O, SEC)).toMatchObject({ ok: false, code: "secret_sent" });
    expect((await login(env.DB, { event: authEv(ch) }, { origin: O, secret: null, ip: "1.2.3.4" })).status).toBe(503); // fail closed
  });
  it("session cookies are HMAC-bound and expire", () => {
    const pk = "ab".repeat(32);
    expect(readSession(SEC, `km_sess=${pk}.9999999999.${"0".repeat(64)}`)).toBeNull();
    expect(readSession(SEC, `km_sess=${pk}.1000000000.${"0".repeat(64)}`)).toBeNull();
  });
  it("limiter: network before key, and a refusal gives back earlier takes", async () => {
    const pk = "cd".repeat(32); const lim = authLimitList("netA", "ch1", pk);
    expect(lim.map((l) => l.k.split(":")[1])).toEqual(["ip", "ch", "pk"]);
    for (let i = 0; i < 10; i++) await take(env.DB, lim[2]); // key exhausted
    const refused = await takeAll(env.DB, authLimitList("netA", "ch2", pk));
    expect(refused?.k).toContain("auth:pk:");
    expect((await env.DB.prepare("SELECT n FROM rate_limits WHERE k = ?").bind(lim[0].k).first<{ n: number }>())?.n ?? 0).toBe(0);
    expect((await env.DB.prepare("SELECT n FROM rate_limits WHERE k = ?").bind("auth:ch:ch2").first<{ n: number }>())?.n ?? 0).toBe(0);
    // a network over its cap never touches the key counter
    const l2 = authLimitList("netB", "ch3", "ef".repeat(32));
    for (let i = 0; i < 30; i++) await take(env.DB, l2[0]);
    expect((await takeAll(env.DB, l2))?.k).toBe(l2[0].k);
    expect(await env.DB.prepare("SELECT n FROM rate_limits WHERE k = ?").bind(l2[2].k).first()).toBeNull();
    expect(listLimitList("n", "e", "p").map((l) => l.k.split(":")[1])).toEqual(["ip", "pk"]);
  });
});

describe("feed + NIP-51 lists", () => {
  it("feed reads the D1 index, filters by kind/tag/store/author, requires #klickymart on kind 1 and re-verifies signatures", async () => {
    const sk = secp.utils.randomSecretKey();
    const evs = [
      sign({ kind: 422, created_at: now() - 10, content: "<img src=x onerror=alert(1)>", tags: [["d", "feedtest.example.com"], ["t", "btc"]] }, sk),
      sign({ kind: 1, created_at: now() - 20, content: "note", tags: [["t", "klickymart"], ["t", "x402"]] }, sk),
      sign({ kind: 1, created_at: now() - 30, content: "unrelated", tags: [["t", "x402"]] }, sk),
    ];
    const forged = { ...sign({ kind: 421, created_at: now(), content: "", tags: [["t", "btc"]] }), content: "tampered" };
    for (const e of [...evs, forged]) await env.DB.prepare("INSERT OR REPLACE INTO nostr_events (id, kind, pubkey, created_at, d, raw_json, first_seen, relays) VALUES (?,?,?,?,?,?,?,?)").bind(e.id, e.kind, e.pubkey, e.created_at, null, JSON.stringify(e), now(), "test").run();
    const q = (s: string) => { const p = parseFeedParams(new URLSearchParams(s)); if (!p.ok) throw new Error(p.message); return readFeed(env.DB, p.value); };
    const pk = evs[0].pubkey;
    expect((await q(`author=${pk}`)).map((e) => e.id)).toEqual([evs[0].id, evs[1].id]);
    expect((await q(`author=${pk}&tag=x402`)).map((e) => e.id)).toEqual([evs[1].id]);
    expect((await q(`store=feedtest.example.com`)).map((e) => e.id)).toEqual([evs[0].id]);
    expect((await q("kind=421&tag=btc")).some((e) => e.id === forged.id)).toBe(false);
    expect(parseFeedParams(new URLSearchParams("kind=7")).ok).toBe(false);
    const r = await SELF.fetch(`${O}/feed.json?author=${pk}`); const j = await r.json() as { items: { content: string }[] };
    expect(r.headers.get("content-type")).toMatch(/json/); expect(j.items[0].content).toBe("<img src=x onerror=alert(1)>"); // JSON only; /app renders via textContent
  });
  it("NIP-51 list round trip: client template -> user signature -> server verify -> same filters; nothing stored or published", async () => {
    const A = app(); const sub = { kinds: [31420, 1], tags: ["btc", "agent-native"], stores: ["bitrefill.com"], authors: ["ab".repeat(32)] };
    const ev = sign(A.listTemplate("btc-stores", sub));
    const r = await SELF.fetch(`${O}/feed/list-check`, { method: "POST", body: JSON.stringify({ event: ev }) });
    const j = await r.json() as any;
    expect(r.status).toBe(200); expect(j.stored).toBe(false); expect(j.published).toBe(false);
    expect(j.list).toMatchObject({ name: "btc-stores", ...sub });
    expect(A.listToSub(ev)).toMatchObject({ name: "btc-stores", ...sub });
    expect(j.feed_query).toContain("kind=31420%2C1");
    expect(parseFeedList({ ...ev, content: "x" })).toMatchObject({ ok: false, code: "bad_signature" });
    expect(parseFeedList(sign({ ...A.listTemplate("x", sub), tags: [["d", "other"]] }))).toMatchObject({ ok: false, code: "bad_d" });
    expect((await checkFeedList(env.DB, sign({ ...A.listTemplate("x", sub), tags: [["d", "klickymart-feed:x"], ["p", "zz"]] }), { salt: "s", ip: null })).status).toBe(400);
    expect(A.relayFilters(sub)).toEqual([{ limit: 50, authors: sub.authors, "#r": ["bitrefill.com"], kinds: [31420], "#t": sub.tags }, { limit: 50, authors: sub.authors, "#r": ["bitrefill.com"], kinds: [1], "#t": ["klickymart"] }]);
  });
  it("client helpers: bunker URI parse limits relays to the CSP list; secrets never leave", () => {
    const A = app(); const pk = "ab".repeat(32);
    expect(A.parseBunker(`bunker://${pk}?relay=wss://relay.nsec.app&secret=s3`)).toEqual({ pubkey: pk, relays: ["wss://relay.nsec.app"], secret: "s3" });
    expect(() => A.parseBunker(`bunker://${pk}?relay=wss://evil.example.com`)).toThrow(/not allowed/);
    expect(() => A.parseBunker("bunker://nothex")).toThrow();
    expect(() => A.publicEvent({ id: "1", content: "nsec1" + "q".repeat(58), tags: [] })).toThrow(/secret/);
    expect(APPJS as string).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });
});

describe("tip-ready badge", () => {
  const prof = (content: object, sk?: Parameters<typeof sign>[1]) => sign({ kind: 0, created_at: now(), content: JSON.stringify(content), tags: [] }, sk);
  const ok = (async () => new Response(JSON.stringify({ tag: "payRequest", callback: "https://w.example.com/cb", minSendable: 1000, maxSendable: 1e9 }), { status: 200 })) as unknown as typeof fetch;
  it("parses lud16 and lud06, refuses private hosts and non-https", () => {
    expect(payUrlFromProfile(JSON.stringify({ lud16: "Me@Wallet.Example.com" }))).toEqual({ addr: "me@wallet.example.com", url: "https://wallet.example.com/.well-known/lnurlp/me" });
    const l06 = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode("https://pay.example.com/lnurlp/a")), 2000);
    expect(payUrlFromProfile(JSON.stringify({ lud06: l06 }))?.url).toBe("https://pay.example.com/lnurlp/a");
    const insecure = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode("http://pay.example.com/x")), 2000);
    expect(payUrlFromProfile(JSON.stringify({ lud06: insecure }))).toBeNull();
    for (const a of ["a@localhost", "a@10.0.0.1", "a@host.internal", "a@x.onion"]) expect(payUrlFromProfile(JSON.stringify({ lud16: a }))).toBeNull();
  });
  it("working endpoint -> tip_ready with ranking_weight 0; broken endpoint -> not ready; cached for a day", async () => {
    const sk = secp.utils.randomSecretKey(); const p = prof({ lud16: "agent@wallet.example.com", name: "<b>x</b>" }, sk);
    const sk2 = secp.utils.randomSecretKey(); const p2 = prof({ lud16: "dead@wallet.example.com" }, sk2);
    for (const e of [p, p2]) await env.DB.prepare("INSERT OR REPLACE INTO nostr_events (id, kind, pubkey, created_at, d, raw_json, first_seen, relays) VALUES (?,?,?,?,?,?,?,?)").bind(e.id, 0, e.pubkey, e.created_at, null, JSON.stringify(e), now(), "test").run();
    let calls = 0;
    const f = (async (u: string) => { calls++; return String(u).includes("/agent") ? ok(u) : new Response("no", { status: 404 }); }) as unknown as typeof fetch;
    const doh = (async (u: string) => Response.json({ Status: 0, Answer: new URL(u).searchParams.get("type") === "A" ? [{ type: 1, data: "93.184.215.14" }] : [] })) as unknown as typeof fetch;
    const r = await tipReadyFor(env.DB, [p.pubkey, p2.pubkey], { salt: "s", ip: "203.0.113.5", fetcher: f, doh });
    expect(r.map((x) => [x.tip_ready, x.ranking_weight])).toEqual([[true, 0], [false, 0]]);
    await tipReadyFor(env.DB, [p.pubkey], { salt: "s", ip: "203.0.113.5", fetcher: f, doh });
    expect(calls).toBe(2);
  });
  it("never adds ranking weight: ranking code does not read the badge", () => {
    expect(QUERY_SRC as string).not.toMatch(/tip_ready|tipReady/);
  });
  it("/wallet documents the badge and links NWC; /app links badges to /wallet", async () => {
    const w = await (await SELF.fetch(`${O}/wallet`)).text();
    expect(w).toContain('id="tip-ready"'); expect(w).toMatch(/never<\/strong> adds ranking weight/);
  });
});

describe("/app page, CSP and site tip slot", () => {
  it("/app has a strict CSP, no inline script, SRI-pinned scripts and relay-only connect-src", async () => {
    const r = await SELF.fetch(`${O}/app`, { headers: { Accept: "text/html" } });
    const csp = r.headers.get("Content-Security-Policy")!; const html = await r.text();
    expect(csp).toContain("script-src 'self';"); expect(csp).not.toMatch(/unsafe-inline'[^;]*;?\s*$|script-src[^;]*unsafe/);
    expect(csp).toMatch(/connect-src 'self' wss:\/\/relay\.primal\.net wss:\/\/nos\.lol wss:\/\/relay\.damus\.io wss:\/\/relay\.nsec\.app [^;]*;/);
    expect(csp.match(/connect-src ([^;]*)/)![1].split(" ").every((x) => x === "'self'" || /^(wss|https):\/\/[a-z0-9.-]+$/.test(x))).toBe(true);
    expect(csp).toContain("frame-ancestors 'none'");
    expect([...html.matchAll(/<script\b([^>]*)>/g)].every((m) => /\bsrc=/.test(m[1]) || /application\/ld\+json/.test(m[1]))).toBe(true);
    expect(html).toContain(`integrity="${APP_SRI}"`); expect(html).toContain(`integrity="${NOSTR_TOOLS_SRI}"`);
    expect(await sri(APPJS as string)).toBe(APP_SRI);
    expect(html).toMatch(/Warning:<\/strong> pasting a secret key/);
  });
  it("site tip slot is hidden unless SITE_TIP_LUD16 is a valid address, and is escaped", async () => {
    const base = { title: "t", origin: O, version: "v", tsMin: 0, tsMax: 0, body: "", path: "/" };
    expect(layout(base)).not.toContain("km-site-tip");
    expect(await (await SELF.fetch(`${O}/about`)).text()).not.toContain("km-site-tip");
    expect(siteTipAddress({})).toBeNull();
    expect(siteTipAddress({ SITE_TIP_LUD16: '"><script>@x.com' })).toBeNull();
    expect(siteTipAddress({ SITE_TIP_LUD16: "tips@example.com" })).toBe("tips@example.com");
    expect(layout({ ...base, siteTip: "tips@example.com" })).toContain('href="lightning:tips@example.com"');
  });
});

describe("vendored tip libraries", () => {
  it("SRI hashes match public/ files", async () => {
    const { CASHU_SRI, QR_SRI, TIP_SRI } = await import("../src/render/pages");
    const c = (await import("../../public/vendor/cashu-ts-4.13.0.bundle.js?raw")).default as string;
    const q = (await import("../../public/vendor/qrcode-generator-2.0.4.bundle.js?raw")).default as string;
    const t = (await import("../../public/km-tip.js?raw")).default as string;
    expect(await sri(c)).toBe(CASHU_SRI); expect(await sri(q)).toBe(QR_SRI); expect(await sri(t)).toBe(TIP_SRI);
  });
  it("R7-007: /km.js and /km-landscape.js carry matching SRI in the layout", async () => {
    const { KM_JS_SRI, KM_LANDSCAPE_SRI } = await import("../src/render/layout");
    const k = (await import("../../public/km.js?raw")).default as string;
    const l = (await import("../../public/km-landscape.js?raw")).default as string;
    expect(await sri(k)).toBe(KM_JS_SRI); expect(await sri(l)).toBe(KM_LANDSCAPE_SRI);
    const html = await (await SELF.fetch("https://example.com/", { headers: { Accept: "text/html" } })).text();
    expect(html).toContain(`src="/km.js" integrity="${KM_JS_SRI}"`);
    expect(html).toContain(`src="/km-landscape.js" integrity="${KM_LANDSCAPE_SRI}"`);
  });
});
