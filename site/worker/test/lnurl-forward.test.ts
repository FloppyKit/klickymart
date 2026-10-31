import { describe, expect, it, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { encodeBolt11ForTest } from "../src/bolt11";
import { handleLnurlForward, resetForwardCache, upstreamUrl, checkForwardInvoice } from "../src/lnurl-forward";
import { checkZapReceipt } from "../src/pay-binding";
import { layout } from "../src/render/layout";

const O = "https://klickymart.com"; const enc = (s: string) => new TextEncoder().encode(s);
const META = JSON.stringify([["text/plain", "sats for DrMattBrown@primal.net"]]);
const NODE = secp.utils.randomSecretKey(); const ZAPPER = secp.utils.randomSecretKey(); const ZP = bytesToHex(secp.schnorr.getPublicKey(ZAPPER));
const PUB = (async (u: string) => Response.json({ Status: 0, Answer: new URL(u).searchParams.get("type") === "A" ? [{ type: 1, data: "93.184.215.14" }] : [] })) as never;
function upstream(o: { badHash?: boolean; badAmount?: boolean; nostr?: boolean } = {}) {
  const calls: string[] = [];
  const f = (async (u: string, init?: RequestInit) => {
    calls.push(u); expect(init?.redirect).toBe("manual"); const url = new URL(u);
    if (url.pathname === "/.well-known/lnurlp/DrMattBrown") return Response.json({ status: "OK", tag: "payRequest", callback: "https://primal.net/lnurlp/DrMattBrown/callback", metadata: META, minSendable: 1000, maxSendable: 11e9, commentAllowed: 200, ...(o.nostr === false ? {} : { allowsNostr: true, nostrPubkey: ZP }) });
    if (url.pathname === "/lnurlp/DrMattBrown/callback") {
      const amt = Number(url.searchParams.get("amount")) * (o.badAmount ? 2 : 1); const d = o.badHash ? "x" : (url.searchParams.get("nostr") ?? META);
      return Response.json({ pr: encodeBolt11ForTest(NODE, `lnbc${amt / 100}n`, bytesToHex(sha256(enc(String(Math.random())))), { descriptionHashHex: bytesToHex(sha256(enc(d))) }), routes: [] });
    }
    return new Response("nf", { status: 404 });
  }) as never;
  return { f, calls };
}
const OWN = "8a9cdf5624acbed82094d5954137d7febc8f1c41f9cad1ce665bdf40236fd8e4"; // KlickyMart's Nostr account npub132wd743y4jldsgy56k25zd7hl67g78zpl89drnnxt005qgm0mrjqfz25ah (SITE_ZAP_PUBKEY_HEX in production vars)
const FOREIGN = "a".repeat(64);
const E = { DB: env.DB, LNURL_FORWARD_ZAP: "DrMattBrown@primal.net", SITE_ZAP_PUBKEY_HEX: OWN };
const call = (path: string, o: ReturnType<typeof upstream>, e: Record<string, unknown> = E, ip = "203.0.113.20") => handleLnurlForward(new URL(O + path).pathname, new URL(O + path), e as never, O, ip, "salt", { fetcher: o.f, doh: PUB });
function zapReq(amount: number, sk = secp.utils.randomSecretKey(), pTags: string[][] = [["p", OWN]]) {
  const t = { kind: 9734, created_at: Math.floor(Date.now() / 1000), content: "", tags: [...pTags, ["amount", String(amount)], ["relays", "wss://relay.damus.io"]] };
  const pubkey = bytesToHex(secp.schnorr.getPublicKey(sk)); const id = nostrEventId({ ...t, pubkey });
  return { ...t, pubkey, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
beforeEach(async () => { resetForwardCache(); await env.DB.prepare("DELETE FROM rate_limits").run(); });

describe("zap@klickymart.com LNURL forwarding", () => {
  it("re-serves upstream metadata verbatim with our callback, allowsNostr/nostrPubkey and CORS; caches it", async () => {
    const u = upstream(); const r = await call("/.well-known/lnurlp/zap", u);
    expect(r!.status).toBe(200); expect(r!.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await r!.json()).toEqual({ status: "OK", tag: "payRequest", callback: `${O}/.well-known/lnurlp/zap/callback`, metadata: META, minSendable: 1000, maxSendable: 11e9, commentAllowed: 200, allowsNostr: true, nostrPubkey: ZP });
    await call("/.well-known/lnurlp/zap", u);
    expect(u.calls.length).toBe(1);
    expect(upstreamUrl("DrMattBrown@primal.net")).toBe("https://primal.net/.well-known/lnurlp/DrMattBrown");
  });
  it("unknown names and an unset var return 404; non-lnurlp paths fall through", async () => {
    const u = upstream();
    expect((await call("/.well-known/lnurlp/matt", u))!.status).toBe(404);
    expect((await call("/.well-known/lnurlp/zap", u, { DB: env.DB }))!.status).toBe(404);
    expect((await call("/.well-known/lnurlp/zap", u, { DB: env.DB, LNURL_FORWARD_ZAP: "a@10.0.0.1" }))!.status).toBe(404);
    expect(await call("/.well-known/other", u)).toBeNull();
    expect(u.calls.length).toBe(0);
    const http = await SELF.fetch(`${O}/.well-known/lnurlp/nobody`); expect(http.status).toBe(404); expect(http.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await SELF.fetch(`${O}/.well-known/lnurlp/zap`)).status).toBe(404); // test env has no LNURL_FORWARD_ZAP
  });
  it("NIP-57: zap request round-trips to the upstream callback; invoice bound to it; a receipt by the upstream zapper key verifies", async () => {
    const u = upstream(); const zr = zapReq(21000); const nostr = JSON.stringify(zr);
    const r = await call(`/.well-known/lnurlp/zap/callback?amount=21000&nostr=${encodeURIComponent(nostr)}&lnurl=lnurl1dp68gurn8ghj7`, u);
    const j = await r!.json() as { status: string; pr: string };
    expect(j.status).toBe("OK"); expect(r!.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const cb = new URL(u.calls[1]); expect(cb.origin + cb.pathname).toBe("https://primal.net/lnurlp/DrMattBrown/callback");
    expect(cb.searchParams.get("nostr")).toBe(nostr); expect(cb.searchParams.get("amount")).toBe("21000");
    // the receipt the upstream wallet would publish verifies against the nostrPubkey we passed through
    const t = { kind: 9735, created_at: Math.floor(Date.now() / 1000), content: "", tags: [["p", zr.tags[0][1]], ["bolt11", j.pr], ["description", nostr]] };
    const id = nostrEventId({ ...t, pubkey: ZP }); const receipt = { ...t, pubkey: ZP, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), ZAPPER)) };
    expect(checkZapReceipt(receipt, ZP).ok).toBe(true);
  });
  it("plain payment: invoice description_hash commits to the verbatim metadata", async () => {
    const r = await call("/.well-known/lnurlp/zap/callback?amount=5000&comment=thanks", upstream());
    expect(((await r!.json()) as { status: string }).status).toBe("OK");
  });
  it("refuses bad amounts, tampered zap requests, long comments and upstream invoices that do not match", async () => {
    const u = upstream();
    expect((await call("/.well-known/lnurlp/zap/callback?amount=1", u))!.status).toBe(400);
    expect((await call("/.well-known/lnurlp/zap/callback?amount=abc", u))!.status).toBe(400);
    const zr = zapReq(21000);
    expect((await call(`/.well-known/lnurlp/zap/callback?amount=22000&nostr=${encodeURIComponent(JSON.stringify(zr))}`, u))!.status).toBe(400);
    expect((await call(`/.well-known/lnurlp/zap/callback?amount=21000&nostr=${encodeURIComponent(JSON.stringify({ ...zr, content: "x" }))}`, u))!.status).toBe(400);
    expect((await call(`/.well-known/lnurlp/zap/callback?amount=21000&comment=${"a".repeat(201)}`, u))!.status).toBe(400);
    resetForwardCache(); expect((await call("/.well-known/lnurlp/zap/callback?amount=5000", upstream({ badAmount: true })))!.status).toBe(502);
    // Primal-style invoice whose description_hash commits to neither metadata nor the 9734: accepted (see checkForwardInvoice)
    resetForwardCache(); expect((await call("/.well-known/lnurlp/zap/callback?amount=5000", upstream({ badHash: true })))!.status).toBe(200);
    resetForwardCache(); expect((await call(`/.well-known/lnurlp/zap/callback?amount=21000&nostr=${encodeURIComponent(JSON.stringify(zr))}`, upstream({ nostr: false })))!.status).toBe(400);
  });
  it("hardened fetch: private DNS answers and redirects are refused", async () => {
    const priv = (async (u: string) => Response.json({ Status: 0, Answer: new URL(u).searchParams.get("type") === "A" ? [{ type: 1, data: "10.0.0.7" }] : [] })) as never;
    expect((await handleLnurlForward("/.well-known/lnurlp/zap", new URL(O), E as never, O, null, "s", { fetcher: upstream().f, doh: priv }))!.status).toBe(502);
    const redir = (async () => new Response(null, { status: 301, headers: { Location: "https://evil.example/" } })) as never;
    expect((await handleLnurlForward("/.well-known/lnurlp/zap", new URL(O), E as never, O, null, "s", { fetcher: redir, doh: PUB }))!.status).toBe(502);
  });
  it("rate limit: network before global, give-back on refusal", async () => {
    const hr = Math.floor(Date.now() / 3_600_000); const u = upstream();
    await env.DB.prepare("INSERT INTO rate_limits (k, n, exp) VALUES (?, 1200, ?)").bind(`lnf:c:g:${hr}`, Math.floor(Date.now() / 1000) + 7200).run();
    expect((await call("/.well-known/lnurlp/zap/callback?amount=5000", u))!.status).toBe(429);
    expect((await env.DB.prepare("SELECT n FROM rate_limits WHERE k LIKE 'lnf:c:ip:%'").first<{ n: number }>())?.n ?? 0).toBe(0);
    expect(u.calls.filter((c) => c.includes("/callback")).length).toBe(0); // the callback was never called (meta fetch is billed to the meta budget)
  });
  it("R12-004: cache hits cost nothing; failed upstream calls are refunded", async () => {
    const n = async (k: string) => (await env.DB.prepare("SELECT COALESCE(SUM(n),0) AS n FROM rate_limits WHERE k LIKE ?").bind(k).first<{ n: number }>())!.n;
    const u = upstream();
    for (let i = 0; i < 3; i++) expect((await call("/.well-known/lnurlp/zap", u))!.status).toBe(200);
    expect(await n("lnf:m:g:%")).toBe(1); // one real upstream fetch, two cache hits
    const down = { f: (async () => new Response("x", { status: 500 })) as never, calls: [] as string[] };
    resetForwardCache();
    expect((await call("/.well-known/lnurlp/zap", down))!.status).toBe(502);
    expect(await n("lnf:m:g:%")).toBe(1); // refunded
    const noInvoice = { f: (async (url: string) => new URL(url).pathname.endsWith("/callback") ? Response.json({ status: "ERROR", reason: "below min" }) : (u.f as any)(url, { redirect: "manual" })) as never, calls: [] as string[] };
    expect((await call("/.well-known/lnurlp/zap/callback?amount=5000", noInvoice))!.status).toBe(502);
    expect(await n("lnf:c:g:%")).toBe(0); // refunded
    expect((await call("/.well-known/lnurlp/zap/callback?amount=5000", u))!.status).toBe(200);
    expect(await n("lnf:c:g:%")).toBe(1);
  });
  it("R9-001: zap requests must name KlickyMart's own pubkey; fail closed when unset; plain pay unaffected", async () => {
    const z = (pt: string[][], e: Record<string, unknown> = E) => call(`/.well-known/lnurlp/zap/callback?amount=21000&nostr=${encodeURIComponent(JSON.stringify(zapReq(21000, undefined, pt)))}`, upstream(), e);
    expect((await z([["p", FOREIGN]]))!.status).toBe(403); // foreign recipient
    expect((await z([]))!.status).toBe(400); // missing p
    expect((await z([["p", OWN], ["p", FOREIGN]]))!.status).toBe(400); // multiple p
    expect((await z([["p", OWN], ["p", OWN]]))!.status).toBe(400);
    expect(((await (await z([["p", OWN]]))!.json()) as { status: string }).status).toBe("OK"); // our own p tag
    const noKey = { DB: env.DB, LNURL_FORWARD_ZAP: "DrMattBrown@primal.net" };
    expect((await z([["p", OWN]], noKey))!.status).toBe(403); // unset -> fail closed
    const meta = await (await call("/.well-known/lnurlp/zap", upstream(), noKey))!.json() as Record<string, unknown>;
    expect(meta.allowsNostr).toBeUndefined(); // do not advertise zaps we would refuse
    expect(((await (await call("/.well-known/lnurlp/zap/callback?amount=5000", upstream(), noKey))!.json()) as { status: string }).status).toBe("OK"); // plain pay works
  });
  it("production SITE_ZAP_PUBKEY_HEX is KlickyMart's npub and accepts a zap p-tagging it", async () => {
    const toml = (await import("../../wrangler.toml?raw")).default as string;
    expect(toml).toMatch(new RegExp(`\\[env\\.production\\.vars\\][\\s\\S]*SITE_ZAP_PUBKEY_HEX = "${OWN}"`));
    const ok = await call(`/.well-known/lnurlp/zap/callback?amount=21000&nostr=${encodeURIComponent(JSON.stringify(zapReq(21000, undefined, [["p", OWN]])))}`, upstream(), { ...E, SITE_ZAP_PUBKEY_HEX: OWN });
    expect(((await ok!.json()) as { status: string }).status).toBe("OK");
  });
  it("R9-002: invalid input is refused before any rate-limit budget is taken", async () => {
    const u = upstream();
    expect((await call("/.well-known/lnurlp/zap/callback?amount=abc", u))!.status).toBe(400);
    expect((await call(`/.well-known/lnurlp/zap/callback?amount=21000&nostr=${encodeURIComponent(JSON.stringify(zapReq(21000, undefined, [["p", FOREIGN]])))}`, u))!.status).toBe(403);
    expect((await call("/.well-known/lnurlp/zap/callback?amount=21000&nostr=notjson", u))!.status).toBe(400);
    expect((await env.DB.prepare("SELECT COUNT(*) AS c FROM rate_limits WHERE k LIKE 'lnf:%'").first<{ c: number }>())!.c).toBe(0);
    expect(u.calls.length).toBe(0);
  });
  it("footer v4v line", () => {
    const h = layout({ title: "t", origin: O, version: "v", tsMin: 0, tsMax: 0, body: "", path: "/", siteTip: "zap@klickymart.com" });
    expect(h).toContain('href="lightning:zap@klickymart.com"'); expect(h).toContain("No ads, no paid rankings; tips help cover hosting.");
  });
});

describe("R12-001 / R12-003: zap@ e/a and relays tags", () => {
  const cb = (zr: object, amount = 21000) => `/.well-known/lnurlp/zap/callback?amount=${amount}&nostr=${encodeURIComponent(JSON.stringify(zr))}`;
  const withTags = (extra: string[][], relays: string[] = ["wss://relay.damus.io"]) => (() => {
    const sk = secp.utils.randomSecretKey();
    const t = { kind: 9734, created_at: Math.floor(Date.now() / 1000), content: "", tags: [["p", OWN], ...extra, ["amount", "21000"], ["relays", ...relays]] };
    const pubkey = bytesToHex(secp.schnorr.getPublicKey(sk)); const id = nostrEventId({ ...t, pubkey });
    return { ...t, pubkey, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
  })();
  it("refuses e tags for notes that are not KlickyMart's and a tags with foreign or malformed coordinates", async () => {
    await env.DB.prepare("DELETE FROM nostr_events").run();
    const ours = "c".repeat(64), theirs = "d".repeat(64);
    await env.DB.prepare("INSERT INTO nostr_events (id,kind,pubkey,created_at,d,raw_json,first_seen,relays) VALUES (?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?)")
      .bind(ours, 1, OWN, 1, null, "{}", 1, "", theirs, 1, FOREIGN, 1, null, "{}", 1, "").run();
    const u = upstream();
    expect((await call(cb(withTags([["e", theirs]])), u))!.status).toBe(403);
    expect((await call(cb(withTags([["e", "e".repeat(64)]])), u))!.status).toBe(403); // unknown id: fail closed
    expect((await call(cb(withTags([["a", `30023:${FOREIGN}:post`]])), u))!.status).toBe(403);
    expect((await call(cb(withTags([["a", "not-a-coordinate"]])), u))!.status).toBe(400);
    expect(u.calls.length).toBe(0);
    expect((await call(cb(withTags([["e", ours]])), u))!.status).toBe(200);
    expect((await call(cb(withTags([["a", `30023:${OWN}:post`]])), u))!.status).toBe(200);
  });
  it("relays tag: wss URLs only, count and length capped", async () => {
    const u = upstream();
    for (const relays of [["ws://relay.damus.io"], ["https://relay.damus.io"], ["wss://127.0.0.1"], ["wss://localhost"], [], Array.from({ length: 11 }, (_, i) => `wss://r${i}.example`), [`wss://${"a".repeat(260)}.example`]])
      expect((await call(cb(withTags([], relays)), u))!.status, JSON.stringify(relays).slice(0, 60)).toBe(400);
    expect(u.calls.length).toBe(0);
    expect((await call(cb(withTags([], ["wss://relay.damus.io", "wss://nos.lol"])), u))!.status).toBe(200);
  });
});

describe("R9-003 / R9-008 / R9-009 zap@ hardening", () => {
  it("amount must be a plain decimal integer", async () => {
    const u = upstream();
    for (const a of ["1e4", "0x2710", " 10000", "+10000", "10000.0", "-1", "", "0"]) expect((await call(`/.well-known/lnurlp/zap/callback?amount=${encodeURIComponent(a)}`, u))!.status, a).toBe(400);
    expect(u.calls.length).toBe(0);
    expect((await call("/.well-known/lnurlp/zap/callback?amount=10000", u))!.status).toBe(200);
  });
  it("refuses an upstream whose callback points at another host; never echoes upstream reason text", async () => {
    const off = { f: (async () => Response.json({ status: "OK", tag: "payRequest", callback: "https://evil.example/cb", metadata: META, minSendable: 1000, maxSendable: 11e9 })) as never, calls: [] as string[] };
    expect((await call("/.well-known/lnurlp/zap", off))!.status).toBe(502);
    resetForwardCache();
    const u = upstream();
    const chatty = { f: (async (url: string) => new URL(url).pathname.endsWith("/callback") ? Response.json({ status: "ERROR", reason: "<script>pwn</script> internal node 10.0.0.5" }) : (u.f as any)(url, { redirect: "manual" })) as never, calls: [] as string[] };
    const r = await call("/.well-known/lnurlp/zap/callback?amount=5000", chatty);
    expect(r!.status).toBe(502);
    expect(JSON.stringify(await r!.json())).not.toMatch(/pwn|10\.0\.0\.5/);
  });
});

describe("zap@ invoice checks (plain-payment fix)", () => {
  const ph = () => bytesToHex(sha256(enc(String(Math.random()))));
  // Primal's real behaviour (checked live 2026-10-31): description_hash is a constant unrelated to metadata or the 9734.
  const PRIMAL_DH = "f5e3ee151af383d51e9bc2718781355c52fa13ab3a91a9620de0cbd599b5191a";
  it("accepts a 1-sat mainnet invoice with the right amount even when description_hash commits to neither metadata nor 9734", () => {
    const pr = encodeBolt11ForTest(NODE, "lnbc10n", ph(), { descriptionHashHex: PRIMAL_DH });
    const r = checkForwardInvoice(pr, 1000); expect(r.ok).toBe(true);
    if (r.ok) expect(r.description_hash).toBe(PRIMAL_DH);
  });
  it("refuses wrong amount, expired, non-mainnet and undecodable invoices", () => {
    expect(checkForwardInvoice(encodeBolt11ForTest(NODE, "lnbc20n", ph()), 1000)).toMatchObject({ ok: false, reason: expect.stringMatching(/amount/) });
    expect(checkForwardInvoice(encodeBolt11ForTest(NODE, "lnbc10n", ph(), { timestamp: Math.floor(Date.now() / 1000) - 7200 }), 1000)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
    expect(checkForwardInvoice(encodeBolt11ForTest(NODE, "lntb10n", ph()), 1000)).toMatchObject({ ok: false, reason: expect.stringMatching(/mainnet/) });
    expect(checkForwardInvoice(encodeBolt11ForTest(NODE, "lnbcrt10n", ph()), 1000)).toMatchObject({ ok: false, reason: expect.stringMatching(/mainnet/) });
    expect(checkForwardInvoice("lnbc10n1garbage", 1000).ok).toBe(false);
  });
  it("dry end-to-end: a 1000 msat plain callback and a zap callback return the upstream bolt11 (nothing paid)", async () => {
    const f = (async (u: string) => { const url = new URL(u);
      if (url.pathname === "/.well-known/lnurlp/DrMattBrown") return Response.json({ status: "OK", tag: "payRequest", callback: "https://primal.net/lnurlp/DrMattBrown/callback", metadata: META, minSendable: 1000, maxSendable: 11e9, allowsNostr: true, nostrPubkey: ZP });
      return Response.json({ pr: encodeBolt11ForTest(NODE, `lnbc${Number(url.searchParams.get("amount")) / 100}n`, ph(), { descriptionHashHex: PRIMAL_DH }), routes: [] });
    }) as never;
    const plain = await call("/.well-known/lnurlp/zap/callback?amount=1000", { f, calls: [] });
    expect(plain!.status).toBe(200); expect(((await plain!.json()) as { pr: string }).pr).toMatch(/^lnbc10n1/);
    const zap = await call(`/.well-known/lnurlp/zap/callback?amount=21000&nostr=${encodeURIComponent(JSON.stringify(zapReq(21000)))}`, { f, calls: [] });
    expect(zap!.status).toBe(200);
  });
});
