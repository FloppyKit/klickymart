import { describe, expect, it, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { encodeBolt11ForTest } from "../src/bolt11";
import { findReceipt, getInvoice, guardedFetch, loadNutzaps, parseNutzap, parseNutzapInfo, privateIp, verifyZapRequest, cashuMints, nwcRelays, DEFAULT_CASHU_MINTS } from "../src/tip-rails";
import { buildFilters, validateRelayEvent, ingestEvents } from "../src/relay-ingest";
import { renderReviewsSection } from "../src/render/pages";
import { makeMockMint } from "./helpers/mock-mint";
import TIPJS from "../../public/km-tip.js?raw";
import CASHU from "../../public/vendor/cashu-ts-4.13.0.bundle.js?raw";
import QUERY_SRC from "../src/query.ts?raw";
import EXP_SRC from "../src/experience.ts?raw";

type T = { kind: number; created_at: number; tags: string[][]; content: string };
const key = () => secp.utils.randomSecretKey();
const pkOf = (sk: Uint8Array) => bytesToHex(secp.schnorr.getPublicKey(sk));
function sign(t: T, sk = key()) { const pubkey = pkOf(sk); const id = nostrEventId({ ...t, pubkey }); return { ...t, pubkey, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) }; }
const now = () => Math.floor(Date.now() / 1000);
const tipLib = () => { const w: Record<string, any> = {}; new Function("window", "document", TIPJS as string)(w, { getElementById: () => null }); return w.KMTipLib; };
const enc = (s: string) => new TextEncoder().encode(s);
const store = (e: { id: string; kind: number; pubkey: string; created_at: number }) => env.DB.prepare("INSERT OR REPLACE INTO nostr_events (id,kind,pubkey,created_at,d,raw_json,first_seen,relays) VALUES (?,?,?,?,?,?,?,?)").bind(e.id, e.kind, e.pubkey, e.created_at, null, JSON.stringify(e), now(), "test").run();
const doh = (ips: string[][]) => { let i = 0; return (async (u: string) => { const t = new URL(u).searchParams.get("type"); const set = ips[Math.min(i, ips.length - 1)]; if (t === "AAAA") i++; return Response.json({ Status: 0, Answer: t === "A" ? set.map((d) => ({ type: 1, data: d })) : [] }); }) as never; };
const PUB = doh([["93.184.215.14"]]);
beforeEach(async () => { await env.DB.prepare("DELETE FROM rate_limits").run(); });

/** Mock LNURL server: LUD-06 metadata + callback that returns a real signed bolt11 bound to the zap request / metadata. */
function lnurl(o: { allowsNostr?: boolean; badAmount?: boolean; badHash?: boolean } = {}) {
  const NODE = key(); const ZAPPER = key(); const metadata = JSON.stringify([["text/plain", "tip"]]); const calls: string[] = [];
  const f = (async (u: string) => {
    calls.push(u); const url = new URL(u);
    if (url.pathname.startsWith("/.well-known/lnurlp/")) return Response.json({ tag: "payRequest", callback: "https://wallet.example/cb", minSendable: 1000, maxSendable: 1e9, metadata, commentAllowed: 100, ...(o.allowsNostr !== false ? { allowsNostr: true, nostrPubkey: pkOf(ZAPPER) } : {}) });
    if (url.pathname === "/cb") {
      const amt = Number(url.searchParams.get("amount")) * (o.badAmount ? 2 : 1); const desc = o.badHash ? "x" : (url.searchParams.get("nostr") ?? metadata);
      const hrp = `lnbc${amt / 100}n`;
      return Response.json({ pr: encodeBolt11ForTest(NODE, hrp, bytesToHex(sha256(enc(String(amt) + Math.random()))), { descriptionHashHex: bytesToHex(sha256(enc(desc))) }) });
    }
    return new Response("nf", { status: 404 });
  }) as never;
  return { f, NODE, ZAPPER, calls, metadata };
}
async function profileWith(lud16: string) { const sk = key(); const p = sign({ kind: 0, created_at: now(), tags: [], content: JSON.stringify({ lud16 }) }, sk); await store(p); return { sk, pk: p.pubkey }; }

describe("SSRF + DNS-rebinding guard", () => {
  it("classifies private and reserved addresses", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1"]) expect(privateIp(ip), ip).toBe(true);
    for (const ip of ["93.184.215.14", "1.1.1.1", "2606:4700::1111"]) expect(privateIp(ip), ip).toBe(false);
  });
  it("refuses http, private hosts, private DNS answers, changed answers and redirects", async () => {
    const ok = (async () => new Response("{}")) as never;
    expect(await guardedFetch("http://a.example/x", { fetcher: ok, doh: PUB })).toMatchObject({ ok: false });
    expect(await guardedFetch("https://localhost/x", { fetcher: ok, doh: PUB })).toMatchObject({ ok: false });
    expect(await guardedFetch("https://a.example:8443/x", { fetcher: ok, doh: PUB })).toMatchObject({ ok: false });
    expect(await guardedFetch("https://a.example/x", { fetcher: ok, doh: doh([["10.0.0.5"]]) })).toMatchObject({ ok: false, reason: "host does not resolve to public addresses" });
    expect(await guardedFetch("https://a.example/x", { fetcher: ok, doh: doh([["93.184.215.14"], ["127.0.0.1"]]) })).toMatchObject({ ok: false, reason: "host address changed during the request" });
    expect(await guardedFetch("https://a.example/x", { fetcher: (async () => new Response(null, { status: 302, headers: { Location: "http://10.0.0.1/" } })) as never, doh: PUB })).toMatchObject({ ok: false, reason: "upstream status 302" });
    expect(await guardedFetch("https://a.example/x", { fetcher: ok, doh: PUB })).toEqual({ ok: true, text: "{}" });
  });
});

describe("Lightning zaps (NIP-57) and plain tips", () => {
  it("zap request built by km-tip.js and signed by a throwaway key gets a bolt11 bound to it (mock LNURL server)", async () => {
    const L = lnurl(); const r = await profileWith("agent@wallet.example"); const payer = key();
    const tmpl = tipLib().buildZapRequest({ recipient: r.pk, e: "ab".repeat(32), k: 422, msat: 21000, comment: "thanks" });
    const zr = sign(tmpl, payer);
    expect(verifyZapRequest(zr)).toMatchObject({ ok: true, recipient: r.pk, amount: 21000, target: "ab".repeat(32) });
    const out = await getInvoice(env.DB, { zap_request: zr }, { salt: "s", ip: "203.0.113.9", fetcher: L.f, doh: PUB });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body).toMatchObject({ ok: true, amount_msat: 21000, zap: true, zap_request_id: zr.id, zapper_pubkey: pkOf(L.ZAPPER), addr: "agent@wallet.example" });
    const cb = new URL(L.calls[1]); expect(cb.searchParams.get("nostr")).toBe(JSON.stringify(zr)); expect(cb.searchParams.get("lnurl")).toMatch(/^lnurl1/);
  });
  it("refuses an invoice with the wrong amount or not bound to the zap request, and zaps to non-zap addresses", async () => {
    const r = await profileWith("agent@wallet.example"); const zr = sign(tipLib().buildZapRequest({ recipient: r.pk, msat: 5000 }));
    expect((await getInvoice(env.DB, { zap_request: zr }, { salt: "s", ip: null, fetcher: lnurl({ badAmount: true }).f, doh: PUB })).body).toMatchObject({ error: { message: "invoice amount differs from the requested amount" } });
    expect((await getInvoice(env.DB, { zap_request: zr }, { salt: "s", ip: null, fetcher: lnurl({ badHash: true }).f, doh: PUB })).body).toMatchObject({ error: { code: "bad_invoice" } });
    expect((await getInvoice(env.DB, { zap_request: zr }, { salt: "s", ip: null, fetcher: lnurl({ allowsNostr: false }).f, doh: PUB })).body).toMatchObject({ error: { code: "zaps_unsupported" } });
  });
  it("plain (non-zap) tip to a lud16 checks the metadata description_hash", async () => {
    const L = lnurl({ allowsNostr: false });
    const out = await getInvoice(env.DB, { lud16: "Tips@Wallet.Example", amount_msat: 2000, comment: "hi" }, { salt: "s", ip: null, fetcher: L.f, doh: PUB });
    expect(out.body).toMatchObject({ ok: true, zap: false, amount_msat: 2000, addr: "tips@wallet.example" });
    expect(new URL(L.calls[1]).searchParams.get("comment")).toBe("hi");
  });
  it("refuses secrets, bad input, tampered zap requests and unknown recipients", async () => {
    const o = { salt: "s", ip: null, fetcher: lnurl().f, doh: PUB };
    expect((await getInvoice(env.DB, { lud16: "a@b.example", amount_msat: 2000, comment: "nostr+walletconnect://x" }, o)).body).toMatchObject({ error: { code: "secret_sent" } });
    expect((await getInvoice(env.DB, { lud16: "a@10.0.0.1", amount_msat: 2000 }, o)).body).toMatchObject({ error: { code: "bad_lud16" } });
    expect((await getInvoice(env.DB, { lud16: "a@b.example", amount_msat: 1 }, o)).body).toMatchObject({ error: { code: "bad_amount" } });
    const zr = sign(tipLib().buildZapRequest({ recipient: "cd".repeat(32), msat: 5000 }));
    expect((await getInvoice(env.DB, { zap_request: { ...zr, content: "edited" } }, o)).body).toMatchObject({ error: { code: "bad_zap_request" } });
    expect((await getInvoice(env.DB, { zap_request: zr, amount_msat: 6000 }, o)).body).toMatchObject({ error: { code: "amount_mismatch" } });
    expect((await getInvoice(env.DB, { zap_request: zr }, o)).status).toBe(404);
  });
  it("limiter: network before key before global, with give-back on refusal", async () => {
    const r = await profileWith("agent@wallet.example"); const payer = key(); const o = { salt: "s", ip: "198.51.100.7", fetcher: lnurl().f, doh: PUB };
    const hr = Math.floor(Date.now() / 3_600_000);
    await env.DB.prepare("INSERT INTO rate_limits (k, n, exp) VALUES (?, 30, ?)").bind(`inv:pk:${pkOf(payer)}:${hr}`, now() + 7200).run();
    const res = await getInvoice(env.DB, { zap_request: sign(tipLib().buildZapRequest({ recipient: r.pk, msat: 5000 }), payer) }, o);
    expect(res.status).toBe(429);
    const ip = await env.DB.prepare("SELECT n FROM rate_limits WHERE k LIKE 'inv:ip:%'").first<{ n: number }>();
    expect(ip?.n ?? 0).toBe(0);
    expect(await env.DB.prepare("SELECT n FROM rate_limits WHERE k LIKE 'inv:g:%'").first()).toBeNull();
  });
  it("finds the 9735 receipt that embeds our zap request and validates the zapper key", async () => {
    const L = lnurl(); const zr = sign(tipLib().buildZapRequest({ recipient: "ef".repeat(32), e: "12".repeat(32), msat: 21000 }));
    const desc = JSON.stringify(zr);
    const receipt = sign({ kind: 9735, created_at: now(), content: "", tags: [["p", "ef".repeat(32)], ["e", "12".repeat(32)], ["bolt11", encodeBolt11ForTest(L.NODE, "lnbc210n", "ab".repeat(32), { descriptionHashHex: bytesToHex(sha256(enc(desc))) })], ["description", desc]] }, L.ZAPPER);
    await store(receipt);
    expect(await findReceipt(env.DB, zr.id, pkOf(L.ZAPPER))).toMatchObject({ found: true, sats: 21, validated: true });
    expect(await findReceipt(env.DB, zr.id, pkOf(key()))).toMatchObject({ found: true, validated: false });
    expect(await findReceipt(env.DB, "00".repeat(32), null)).toEqual({ found: false });
    const http = await (await SELF.fetch(`https://klickymart.com/tip/receipt?zap_request=${zr.id}&zapper=${pkOf(L.ZAPPER)}`)).json() as { found: boolean; validated: boolean };
    expect(http).toMatchObject({ found: true, validated: true });
    expect((await SELF.fetch("https://klickymart.com/tip/receipt?zap_request=nothex")).status).toBe(400);
  });
  it("HTTP /tip/invoice answers JSON errors without touching the network for bad input", async () => {
    const r = await SELF.fetch("https://klickymart.com/tip/invoice", { method: "POST", body: JSON.stringify({ recipient: "ab".repeat(32), amount_msat: 2000 }) });
    expect(r.status).toBe(404); expect(((await r.json()) as any).error.code).toBe("no_lightning");
    expect((await SELF.fetch("https://klickymart.com/tip/invoice", { method: "POST", body: "not json" })).status).toBe(400);
  });
  it("NWC helpers: relay allowlist, one pay_invoice of exactly this amount", () => {
    const L = tipLib(); const w = "ab".repeat(32), s = "cd".repeat(32);
    const c = L.parseNwc(`nostr+walletconnect://${w}?relay=wss://relay.getalby.com/v1&secret=${s}`, ["wss://relay.getalby.com"]);
    expect(c).toEqual({ walletPubkey: w, relay: "wss://relay.getalby.com/v1", secret: s });
    expect(() => L.parseNwc(`nostr+walletconnect://${w}?relay=wss://evil.example&secret=${s}`, ["wss://relay.getalby.com"])).toThrow(/only use/);
    const sess = L.nwcSession(c, "lnbc1x", 21000, 21000);
    expect(() => sess.payInvoice("lnbc1other")).toThrow(/limited/);
    expect(sess.payInvoice("lnbc1x")).toEqual({ method: "pay_invoice", params: { invoice: "lnbc1x", amount: 21000 } });
    expect(() => sess.payInvoice("lnbc1x")).toThrow(/already paid/);
    expect(() => L.nwcSession(c, "lnbc1x", 21000, 42000).payInvoice("lnbc1x")).toThrow(/amount/);
    expect(TIPJS as string).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(TIPJS as string).not.toMatch(/fetch\([^)]*(nwc|token)/i);
  });
});

describe("Cashu nutzaps (NIP-61)", () => {
  const CT = () => new Function("window", (CASHU as string) + "\nreturn CashuTs;")({});
  it("swaps a token at a (mock) recipient mint into P2PK-locked proofs, builds and signs a 9321, and the server parses it as locked", async () => {
    const m = makeMockMint("https://mint.mock.test"); const real = globalThis.fetch;
    globalThis.fetch = ((u: RequestInfo, i?: RequestInit) => String(u).startsWith(m.base) ? m.handle(String(u), i) : real(u as never, i)) as typeof fetch;
    try {
      const recipientSk = key(); const recipient = pkOf(recipientSk); const p2pkSk = key(); const p2pk = "02" + pkOf(p2pkSk);
      const info = sign({ kind: 10019, created_at: now(), content: "", tags: [["relay", "wss://relay.damus.io"], ["mint", m.base, "sat"], ["pubkey", p2pk]] }, recipientSk);
      const I = parseNutzapInfo(info)!; expect(I).toMatchObject({ mints: [m.base], p2pk, relays: ["wss://relay.damus.io"] });
      const C = CT(); const token = C.getEncodedToken({ mint: m.base, proofs: m.fakeProofs(100) });
      expect(tipLib().mintAllowed(C.getTokenMetadata(token).mint, I.mints, [m.base])).toBeNull();
      expect(tipLib().mintAllowed(C.getTokenMetadata(token).mint, I.mints, DEFAULT_CASHU_MINTS)).toMatch(/only contact/);
      expect(tipLib().mintAllowed("https://other.mint", I.mints, [m.base])).toMatch(/not one of/);
      const w = new C.Wallet(m.base); await w.loadMint();
      const res = await w.ops.send(21, w.decodeToken(token).proofs).asP2PK({ pubkey: p2pk }).run();
      const locked: string[] = C.serializeProofs(res.send);
      expect(m.swaps.length).toBe(1);
      const nz = sign(tipLib().buildNutzap({ recipient, e: "34".repeat(32), k: 422, mint: m.base, proofs: locked, comment: "nice" }));
      const parsed = parseNutzap(nz, I)!;
      expect(parsed).toMatchObject({ sats: 21, locked_to_recipient: true, mint_listed: true, target: "34".repeat(32), recipient });
      expect(parseNutzap(nz, { ...I, p2pk: "02" + "11".repeat(32) })!.locked_to_recipient).toBe(false);
      expect(parseNutzap({ ...nz, content: "x" }, I)).toBeNull();
      // stored + loaded for display
      await store(info); await store(nz);
      const by = await loadNutzaps(env.DB, ["34".repeat(32)]);
      expect(by.get("34".repeat(32))?.[0]).toMatchObject({ sats: 21, locked_to_recipient: true });
      const http = await (await SELF.fetch(`https://klickymart.com/tip/nutzaps.json?e=${"34".repeat(32)}`)).json() as { items: { nutzaps: { sats: number }[] }[] };
      expect(http.items[0].nutzaps[0].sats).toBe(21);
      const tr = await (await SELF.fetch(`https://klickymart.com/tip-ready.json?pubkeys=${recipient}`)).json() as { items: any[] };
      expect(tr.items[0]).toMatchObject({ tip_ready: true, rails: { lightning: false, cashu: true }, ranking_weight: 0, cashu: { mints: [m.base], p2pk } });
    } finally { globalThis.fetch = real; }
  });
  it("R8-007 repro: forged 9321s (unlocked, wrong key, unlisted mint) are dropped; a lock-shaped one at a listed mint is shown only as claimed", async () => {
    const rSk = key(); const r = pkOf(rSk); const p2 = "02" + pkOf(key()); const target = "5a".repeat(32);
    await store(sign({ kind: 10019, created_at: now(), content: "", tags: [["mint", "https://mint.listed.example"], ["pubkey", p2]] }, rSk));
    const lockTo = (k: string) => JSON.stringify(["P2PK", { nonce: "00", data: k }]);
    const nz = (mint: string, secret: string, amount = 1000000) => sign({ kind: 9321, created_at: now(), content: "", tags: [["proof", JSON.stringify({ amount, secret, C: "02" + "00".repeat(32), id: "00" })], ["u", mint], ["e", target], ["p", r]] });
    const forged = [nz("https://mint.listed.example", "plain-secret"), nz("https://mint.listed.example", lockTo("02" + "11".repeat(32))), nz("https://evil.mint.example", lockTo(p2))];
    for (const f of forged) await store(f);
    expect((await loadNutzaps(env.DB, [target])).get(target) ?? []).toEqual([]);
    await store(nz("https://mint.listed.example", lockTo(p2), 21));
    const got = (await loadNutzaps(env.DB, [target])).get(target)!; expect(got.length).toBe(1); expect(got[0].sats).toBe(21);
    const j = await (await SELF.fetch(`https://klickymart.com/tip/nutzaps.json?e=${target}`)).json() as { note: string };
    expect(j.note).toMatch(/always claimed/);
  });
  it("R8-012: swapped proofs and change go to IndexedDB before signing/publishing; one confirm before the swap; retry/export view", () => {
    const src = TIPJS as string; const h = src.slice(src.indexOf('$("km-tip-nutzap").addEventListener'));
    const order = ["confirm(", "vaultPut(rec).then", "w.ops.send", "rec.locked = ", "return vaultPut(rec)", "signRec(rec)", "publishRec"].map((x) => h.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(src).toMatch(/Retry publish/); expect(src).toMatch(/Export JSON/); expect(src).toMatch(/no IndexedDB[^"]*not swapping/);
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });
  it("tip-ready without 10019 or lud16 is false; ingest follows 9321/10019 and keeps nutzaps only for held events", async () => {
    const tr = await (await SELF.fetch(`https://klickymart.com/tip-ready.json?pubkeys=${"77".repeat(32)}`)).json() as { items: any[] };
    expect(tr.items[0]).toMatchObject({ tip_ready: false, rails: { lightning: false, cashu: false }, cashu: null });
    const f = buildFilters({ domains: new Set(["a.com"]), ourPubkey: null }, 0, ["ab".repeat(32)], ["cd".repeat(32)]);
    expect(f).toContainEqual({ kinds: [9321], "#e": ["ab".repeat(32)] });
    expect(f).toContainEqual({ kinds: [10019], authors: ["cd".repeat(32)] });
    const ctx = { domains: new Set(["a.com"]), ourPubkey: null };
    const nz = sign({ kind: 9321, created_at: now(), content: "", tags: [["proof", JSON.stringify({ amount: 1, secret: "s", C: "02", id: "00" })], ["e", "99".repeat(32)], ["p", "cd".repeat(32)]] });
    expect(validateRelayEvent(nz, ctx).ok).toBe(true);
    expect(validateRelayEvent(sign({ kind: 9321, created_at: now(), content: "", tags: [] }), ctx).ok).toBe(false);
    expect(validateRelayEvent(sign({ kind: 10019, created_at: now(), content: "", tags: [] }), ctx).ok).toBe(true);
    const r = await ingestEvents(env.DB, [{ ev: nz, relay: "wss://relay.damus.io" }], ctx);
    expect(r.rejected).toBeGreaterThan(0);
  });
});

describe("display, ranking and CSP", () => {
  it("reviews show 'tipped' with verified counts, a tip link, and escape everything", () => {
    const rv = { count: 1, avg_rating_5: 5, note: "", items: [{ id: "ab".repeat(32), d: "x.com", pubkey: "cd".repeat(32), created_at: now(), rating: 5, rating_max: 5, attempt: "completed", pay: null, fulfillment: null, proof: null, content: "<script>alert(1)</script> $& $1", verified: "unverified", event: {} }] } as never;
    const html = renderReviewsSection("x.com", rv, null, new Map([["ab".repeat(32), { zaps: 2, zap_sats: 42, zap_validated: 1, nutzaps: 1, nutzap_sats: 21, nutzap_checked: 1 }]]));
    expect(html).toContain("tipped: 2 zaps · 42 sats (1 verified); 1 nutzap · 21 sats claimed (locked to the author Cashu key at a mint they list; mint signatures not checked)");
    expect(html).toContain(`/app?tip=${"cd".repeat(32)}&amp;e=${"ab".repeat(32)}&amp;k=422`);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; $&amp; $1"); expect(html).not.toContain("<script>alert");
  });
  it("tips add no new ranking weight: ranking code never reads nutzaps or tip-ready", () => {
    for (const src of [QUERY_SRC, EXP_SRC] as string[]) expect(src).not.toMatch(/9321|nutzap|tip_ready|tip-rails/i);
  });
  it("/app CSP allows exactly the configured mints and NWC relays; /app nav link; vendored libs pinned", async () => {
    expect(cashuMints({ CASHU_MINTS: "https://mint.a.example/, javascript:alert(1), http://10.0.0.1:80, http://127.0.0.1:3338" })).toEqual(["https://mint.a.example", "http://127.0.0.1:3338"]);
    expect(nwcRelays({ NWC_RELAYS: "wss://r.example,https://x" })).toEqual(["wss://r.example"]);
    const r = await SELF.fetch("https://klickymart.com/app"); const csp = r.headers.get("Content-Security-Policy")!; const html = await r.text();
    for (const m of DEFAULT_CASHU_MINTS) expect(csp).toContain(m);
    expect(csp).toContain("wss://relay.getalby.com"); expect(csp).toContain("script-src 'self';"); expect(csp).not.toMatch(/connect-src[^;]*(\*|https:(\s|;)|wss:(\s|;))/);
    expect(html).toMatch(/cashu-ts-4\.13\.0\.bundle\.js" integrity="sha384-/); expect(html).toMatch(/km-tip\.js" integrity="sha384-/);
    expect(await (await SELF.fetch("https://klickymart.com/about")).text()).toContain('href="/app"');
    const w = await (await SELF.fetch("https://klickymart.com/wallet")).text();
    expect(w).toContain('id="cashu-nutzaps"'); expect(w).toContain('id="nwc-tips"'); expect(w).toMatch(/Who holds the funds:<\/strong> the mint holds/);
  });
});
