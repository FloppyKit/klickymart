import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { NOSTR_KIND_STORE_SUGGESTION } from "../src/nostr-kinds";
import { buildFilters, validateRelayEvent, ingestEvents } from "../src/relay-ingest";
import { cleanNote, computeTrustTiers, ipHash, lookalikeOf, normalizeSubmitDomain, punyDecode, registrable, submitStore, type SubmitCtx } from "../src/submissions";

const DAY = 86400;
const nowS = () => Math.floor(Date.now() / 1000);
const INDEXED = new Set(["store.google.com", "microsoft.com", "apple.com", "amazon.com", "netflix.com", "bestbuy.com", "dell.com"]);
const ctx = (o: Partial<SubmitCtx> = {}): SubmitCtx => ({ db: env.DB, indexed: INDEXED, salt: "t", ip: "203.0.113.9", via: "post", origin: "https://km.test", ...o });
let n = 0;
const uniq = (p = "shop") => `${p}${++n}${Math.random().toString(36).slice(2, 7)}.example.org`.replace(".example.org", ".com");
const pk = () => bytesToHex(secp.schnorr.getPublicKey(secp.utils.randomSecretKey()));
function sign1423(tags: string[][], content = "small store", sk = secp.utils.randomSecretKey(), created_at = nowS()) {
  const ev = { pubkey: bytesToHex(secp.schnorr.getPublicKey(sk)), created_at, kind: NOSTR_KIND_STORE_SUGGESTION, tags, content };
  const id = nostrEventId(ev);
  return { ...ev, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
let seq = 0;
async function visit(d: string, pubkey: string, o: { created_at?: number; proof_status?: string; flagged?: number; firstSeen?: number } = {}) {
  const id = (++seq).toString(16).padStart(8, "0") + "f".repeat(56);
  const t = o.created_at ?? nowS() - DAY;
  await env.DB.prepare("INSERT INTO experiences (id,kind,d,pubkey,created_at,structured,content,raw_json,source,received_day,basis,proof_status) VALUES (?,?,?,?,?,1,'','{}','post','2026-10-30','visit',?)").bind(id, 422, d, pubkey, t, o.proof_status ?? null).run();
  if (o.firstSeen !== undefined) await env.DB.prepare("INSERT OR IGNORE INTO nostr_events (id,kind,pubkey,created_at,d,raw_json,first_seen,relays) VALUES (?,0,?,?,NULL,'{}',?,'')").bind(id.slice(0, 8) + "0".repeat(56), pubkey, o.firstSeen, o.firstSeen).run();
  if (o.flagged !== undefined) await env.DB.prepare("INSERT INTO note_flags (id,d,pubkey,level,weight,reasons_json,computed_at) VALUES (?,?,?,?,?,?,?)").bind(id, d, pubkey, o.flagged === 0 ? "strong" : "weak", o.flagged, JSON.stringify([{ signal: "near-duplicate", strength: "weak", detail: "x" }]), nowS()).run();
  return id;
}
const old = () => nowS() - 90 * DAY;
const tier = async (d: string, raw: Record<string, unknown> | null = null) => (await computeTrustTiers(env.DB, [d], () => raw, Date.now(), { noCache: true })).get(d)!;

describe("domain normalization and abuse filters", () => {
  it("keeps only the bare registrable domain and flags stripped referral params", () => {
    const r = normalizeSubmitDomain("https://www.Shop.Roaster.co.uk/p/beans?ref=abc&utm_source=x#top");
    expect(r.ok && r.domain).toBe("roaster.co.uk");
    expect(r.ok && r.flags.map((f) => f.flag)).toContain("affiliate-param");
    expect(r.ok && r.stripped.join(" ")).toMatch(/path\/query/);
    expect(registrable("a.b.example.com")).toBe("example.com");
  });
  it("rejects IPs, reserved TLDs, link shorteners and affiliate networks", () => {
    expect(normalizeSubmitDomain("192.168.1.1").ok).toBe(false);
    expect(normalizeSubmitDomain("shop.invalid").ok).toBe(false);
    expect(normalizeSubmitDomain("localhost").ok).toBe(false);
    expect(normalizeSubmitDomain("https://amzn.to/3xyz")).toMatchObject({ ok: false, code: "affiliate_host" });
    expect(normalizeSubmitDomain("go.skimresources.com/?id=1")).toMatchObject({ ok: false, code: "affiliate_host" });
  });
  it("strips links and key-like strings from notes and flags spam", () => {
    const c = cleanNote("great shop https://evil.example/aff?x=1 nsec1" + "q".repeat(58));
    expect(c.note).not.toMatch(/https|nsec1/);
    expect(c.flags).toEqual([]);
    expect(cleanNote("best casino bonus").flags[0]!.flag).toBe("spam");
    expect(cleanNote("a http://a.co b http://b.co c http://c.co").flags[0]!.flag).toBe("spam");
  });
  it("salted IP hash: no raw IP, stable within a week, salt-dependent", () => {
    const h = ipHash("203.0.113.9", "s1")!;
    expect(h).not.toContain("203");
    expect(h).toBe(ipHash("203.0.113.9", "s1"));
    expect(h).not.toBe(ipHash("203.0.113.9", "s2"));
  });
});

describe("look-alike / punycode check", () => {
  it("decodes punycode", () => { expect(punyDecode("mnchen-3ya")).toBe("münchen"); expect(punyDecode("pple-43d")).toBe("аpple"); });
  it("flags homoglyphs, digit swaps, rn->m and small edits; not unrelated names", () => {
    expect(lookalikeOf("amaz0n.com", null, INDEXED)).toBe("amazon.com");
    expect(lookalikeOf("arnazon.com", null, INDEXED)).toBe("amazon.com");
    expect(lookalikeOf("bestbuuy.com", null, INDEXED)).toBe("bestbuy.com");
    expect(lookalikeOf("amazon.shop", null, INDEXED)).toBe("amazon.com");
    const cyr = normalizeSubmitDomain("https://аpple.com/"); // Cyrillic а
    expect(cyr.ok && cyr.domain.startsWith("xn--")).toBe(true);
    expect(cyr.ok && lookalikeOf(cyr.domain, cyr.unicode, INDEXED)).toBe("apple.com");
    expect(lookalikeOf("roastery-beans.com", null, INDEXED)).toBeNull();
    expect(lookalikeOf("amazon.com", null, INDEXED)).toBeNull();
  });
  it("a look-alike submission is queued but labeled flagged, not hidden", async () => {
    const r = await submitStore({ domain: "amaz0n.com" }, ctx({ ip: "198.51.100.1" }));
    expect(r.body.status).toBe("queued");
    expect(r.body.trust_tier).toBe("flagged");
    expect(String(r.body.trust_label)).toMatch(/Flagged: lookalike\?/);
    expect((await tier("amaz0n.com")).trust_tier).toBe("flagged");
  });
});

describe("POST /submit and submit_store", () => {
  it("dry_run validates and stores nothing", async () => {
    const d = uniq();
    const r = await SELF.fetch("https://km.test/submit?dry_run=1", { method: "POST", body: JSON.stringify({ domain: d, category: "Coffee!", note: "hi", pay: ["btc"] }) });
    const b = await r.json() as Record<string, unknown>;
    expect(r.status).toBe(200);
    expect(b).toMatchObject({ status: "queued", stored: false, dry_run: true, trust_tier: "unverified", category_hint: "coffee" });
    expect(b.ignored_fields).toEqual(["pay"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM store_submissions WHERE domain = ?").bind(d).first("n")).toBe(0);
  });
  it("queues, dedupes, reports indexed stores as duplicate and rejects blocklisted domains", async () => {
    const d = uniq();
    const r1 = await submitStore({ domain: `https://${d}/x?aff=1` }, ctx({ ip: "198.51.100.2" }));
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ status: "queued", domain: d, stored: true });
    const r2 = await submitStore({ domain: d }, ctx({ ip: "198.51.100.3" }));
    expect(r2.body).toMatchObject({ status: "duplicate", reason: "already queued for the gated crawl" });
    expect(await env.DB.prepare("SELECT submissions FROM crawl_queue WHERE domain = ?").bind(d).first("submissions")).toBe(2);
    expect((await submitStore({ domain: "www.amazon.com" }, ctx())).body).toMatchObject({ status: "duplicate", reason: "already indexed" });
    expect((await submitStore({ domain: "wacaco.com" }, ctx())).body).toMatchObject({ status: "rejected" });
  });
  it("GET /submit/:id, queue export, /check queued:true", async () => {
    const d = uniq();
    const r = await (await SELF.fetch("https://km.test/submit", { method: "POST", body: JSON.stringify({ domain: d, category: "tea", submitter: { agent_name: "test-agent", npub: "npub1fake" } }) })).json() as Record<string, unknown>;
    expect(r.submitted_by).toMatch(/^agent:/);
    expect(r.npub_claim_ignored).toBeTruthy();
    const s = await (await SELF.fetch(`https://km.test/submit/${r.id}`)).json() as Record<string, unknown>;
    expect(s).toMatchObject({ domain: d, status: "queued", trust_tier: "unverified", trust_label: "Unverified · community-submitted" });
    const q = await (await SELF.fetch("https://km.test/submit/queue.json")).json() as { items: { domain: string }[] };
    expect(q.items.some((x) => x.domain === d)).toBe(true);
    expect(JSON.stringify(q)).not.toMatch(/ip_hash|agent:/);
    const c = await (await SELF.fetch(`https://km.test/check?domain=${d}`)).json() as Record<string, unknown>;
    expect(c).toMatchObject({ queued: true, trust_tier: "unverified", src: "community" });
  });
  it("MCP submit_store works and is listed", async () => {
    const d = uniq();
    const call = await (await SELF.fetch("https://km.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_store", arguments: { domain: d, dry_run: true } } }) })).json() as { result: { structuredContent: Record<string, unknown> } };
    expect(call.result.structuredContent).toMatchObject({ status: "queued", via: "mcp", stored: false });
  });
  it("accepts a signed kind 1423 note (POST body and relay ingest); tampered = 400", async () => {
    const d = uniq();
    const ev = sign1423([["r", d], ["t", "books"], ["t", "klickymart"]]);
    const r = await SELF.fetch("https://km.test/submit?dry_run=1", { method: "POST", body: JSON.stringify({ event: ev }) });
    expect(await r.json()).toMatchObject({ status: "queued", via: "nostr", submitted_by: ev.pubkey, category_hint: "books" });
    expect((await SELF.fetch("https://km.test/submit", { method: "POST", body: JSON.stringify({ event: { ...ev, content: "x" } }) })).status).toBe(400);
    const ictx = { domains: INDEXED, ourPubkey: null };
    expect(validateRelayEvent(ev, ictx)).toEqual({ ok: true, d: null });
    expect(buildFilters(ictx, 0).some((f) => (f.kinds as number[]).includes(1423))).toBe(true);
    await ingestEvents(env.DB, [{ ev, relay: "wss://r.test" }], ictx);
    expect(await env.DB.prepare("SELECT submitter FROM store_submissions WHERE event_id = ?").bind(ev.id).first("submitter")).toBe(ev.pubkey);
  });
});

describe("rate limits", () => {
  it("10/day per submitter key", async () => {
    const sub = { agent_name: "burst-" + Math.random() };
    for (let i = 0; i < 10; i++) expect((await submitStore({ domain: uniq("rl"), submitter: sub }, ctx({ ip: `192.0.2.${i}` }))).status).toBe(201);
    const r = await submitStore({ domain: uniq("rl"), submitter: sub }, ctx({ ip: "192.0.2.200" }));
    expect(r.status).toBe(429);
    expect(r.body.reason).toBe("rate_limited");
  });
  it("10/day per salted IP hash, even for anonymous submitters; dry runs count against nothing", async () => {
    const ip = "100.64.9." + Math.floor(Math.random() * 250);
    for (let i = 0; i < 3; i++) await submitStore({ domain: uniq("dr") }, ctx({ ip, dryRun: true }));
    for (let i = 0; i < 10; i++) expect((await submitStore({ domain: uniq("ip") }, ctx({ ip }))).status).toBe(201);
    expect((await submitStore({ domain: uniq("ip") }, ctx({ ip }))).status).toBe(429);
    expect((await submitStore({ domain: uniq("ip") }, ctx({ ip: ip + "1" }))).status).toBe(201);
    const rows = await env.DB.prepare("SELECT ip_hash FROM store_submissions WHERE ip_hash IS NOT NULL LIMIT 50").all<{ ip_hash: string }>();
    expect(rows.results.every((r) => !/\d+\.\d+\.\d+/.test(r.ip_hash))).toBe(true);
  });
  it("mostly-flagged recent submissions cut the key to 1/day; more than 3 sub-domains are collapsed and flagged", async () => {
    const sub = { agent_name: "spammy-" + Math.random() };
    await submitStore({ domain: "amaz0n.net", submitter: sub }, ctx({ ip: "192.0.2.50" }));
    await submitStore({ domain: "rnicrosoft.com", submitter: sub }, ctx({ ip: "192.0.2.51" }));
    expect((await submitStore({ domain: uniq("ok"), submitter: sub }, ctx({ ip: "192.0.2.52" }))).status).toBe(429);
    const s2 = { agent_name: "subs-" + Math.random() }; const base = uniq("base");
    const rs = [];
    for (const p of ["a", "b", "c", "d"]) rs.push(await submitStore({ domain: `${p}.${base}`, submitter: s2 }, ctx({ ip: "192.0.2.60" })));
    expect(rs[0]!.body.status).toBe("queued");
    expect(rs[3]!.body.flags).toEqual(expect.arrayContaining([expect.objectContaining({ flag: "subdomain-stuffing" })]));
  });
});

describe("trust ladder", () => {
  it("unverified -> seen with 3 real keys; tier is shown on /q items", async () => {
    const d = uniq("lad");
    expect((await tier(d)).trust_tier).toBe("unverified");
    for (let i = 0; i < 2; i++) await visit(d, pk(), { firstSeen: old() });
    expect((await tier(d)).trust_tier).toBe("unverified");
    await visit(d, pk(), { firstSeen: old() });
    const t = await tier(d);
    expect(t.trust_tier).toBe("seen");
    expect(t.trust_label).toBe("Seen by shoppers · 3 visits");
    const q = await (await SELF.fetch("https://km.test/q?limit=3")).json() as { items: Record<string, unknown>[] };
    expect(q.items[0]).toHaveProperty("trust_tier");
    expect(q.items[0]).toHaveProperty("trust_label");
    expect((await SELF.fetch("https://km.test/q?min_trust=bogus")).status).toBe(400);
  });
  it("new keys weigh 0.5: 2 real + 2 new = seen; 1 real + 4 new is not (needs 2 real keys)", async () => {
    const a = uniq("w");
    await visit(a, pk(), { firstSeen: old() }); await visit(a, pk(), { firstSeen: old() });
    await visit(a, pk()); await visit(a, pk());
    expect((await tier(a)).trust_tier).toBe("seen");
    const b = uniq("w");
    await visit(b, pk(), { firstSeen: old() });
    for (let i = 0; i < 4; i++) await visit(b, pk());
    const tb = await tier(b);
    expect(tb.seen).toMatchObject({ weighted: 3, real_keys: 1 });
    expect(tb.trust_tier).toBe("unverified");
  });
  it("a key with unflagged notes on 2 other stores counts as real", async () => {
    const d = uniq("rk"); const k = pk();
    await visit(uniq("o"), k); await visit(uniq("o"), k);
    await visit(d, k); await visit(d, pk(), { firstSeen: old() }); await visit(d, pk(), { firstSeen: old() });
    expect((await tier(d)).seen.real_keys).toBe(3);
  });
  it("flagged notes do not count, and > 40% flagged basis notes keep a store from seen", async () => {
    const d = uniq("fl");
    for (let i = 0; i < 3; i++) await visit(d, pk(), { firstSeen: old() });
    await visit(d, pk(), { firstSeen: old(), flagged: 0.5 });
    expect((await tier(d)).trust_tier).toBe("seen");
    const e = uniq("fl");
    for (let i = 0; i < 3; i++) await visit(e, pk(), { firstSeen: old() });
    await visit(e, pk(), { firstSeen: old(), flagged: 0 }); await visit(e, pk(), { firstSeen: old(), flagged: 0.5 }); await visit(e, pk(), { firstSeen: old(), flagged: 0.5 });
    const t = await tier(e);
    expect(t.seen.keys).toBe(3);
    expect(t.trust_tier).toBe("unverified");
    expect(t.trust_why[0]!.kind).toBe("basis-notes-flagged");
    const f = uniq("fl");
    await visit(f, pk(), { firstSeen: old() }); await visit(f, pk(), { firstSeen: old() }); await visit(f, pk(), { firstSeen: old(), flagged: 0.5 });
    expect((await tier(f)).trust_tier).toBe("unverified");
  });
  it("notes older than 60 days, the submitter's own key and keys first seen within 24 h of the submission do not count", async () => {
    const d = uniq("sy");
    for (let i = 0; i < 3; i++) await visit(d, pk(), { firstSeen: old(), created_at: nowS() - 70 * DAY });
    expect((await tier(d)).trust_tier).toBe("unverified");
    const s = uniq("sy"); const sk = secp.utils.randomSecretKey(); const ev = sign1423([["r", s]], "x", sk);
    await submitStore({}, ctx({ via: "nostr", signed: { id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, domain: s, category: null, note: "", evidence_url: null }, ip: null }));
    await visit(s, ev.pubkey, { firstSeen: old() });
    await visit(s, pk(), { firstSeen: old() }); await visit(s, pk(), { firstSeen: old() });
    await visit(s, pk(), { firstSeen: nowS() - 60, created_at: nowS() - 60 }); // sybil: created right after the submission
    const t = await tier(s);
    expect(t.src).toBe("community");
    expect(t.seen.keys).toBe(2);
    expect(t.trust_tier).toBe("unverified");
    await visit(s, pk(), { firstSeen: old() });
    expect((await tier(s)).trust_tier).toBe("seen");
  });
  it("verified by payment proof (not from the submitter, not flagged) or a protocol endpoint", async () => {
    const d = uniq("pv");
    await visit(d, pk(), { firstSeen: old(), proof_status: "verified-preimage", flagged: 0 });
    expect((await tier(d)).trust_tier).toBe("unverified");
    await visit(d, pk(), { firstSeen: old(), proof_status: "verified-preimage" });
    const t = await tier(d);
    expect(t.trust_tier).toBe("verified");
    expect(t.trust_label).toBe("Verified (payment proof)");
    const u = await tier(uniq("ucp"), { ucp: { present: true, endpoint: "https://x.myshopify.com/api/ucp/mcp", src: "https://x/.well-known/ucp" } });
    expect(u.trust_label).toBe("Verified (protocol endpoint)");
    expect((await tier(uniq("ucp"), { ucp: { present: false, endpoint: null } })).trust_tier).toBe("unverified");
    expect((await tier(uniq("x4"), { an_402: { result: "verified-402", proto: "l402", endpoint: "https://api.x/pay" } })).trust_label).toBe("Verified (protocol endpoint)");
    expect((await tier(uniq("x4"), { an_rails: ["l402"], an_402: { result: "claimed" }, agent_api: { endpoint: "https://api.x" } })).trust_tier).toBe("unverified");
  });
  it("verified by store claim: NIP-05 key on the domain that signed its own 31420", async () => {
    const d = uniq("cl"); const k = pk();
    await env.DB.prepare("INSERT INTO nip05_checks (pubkey,nip05,domain,status,checked_at) VALUES (?,?,?,?,?)").bind(k, `_@${d}`, d, "verified", nowS()).run();
    expect((await tier(d)).trust_tier).toBe("unverified");
    await env.DB.prepare("INSERT INTO site_records (pubkey,d,id,created_at,raw_json,relays) VALUES (?,?,?,?,?,?)").bind(k, d, "e".repeat(64), nowS(), "{}", "").run();
    expect((await tier(d)).trust_label).toBe("Verified (store claim)");
  });
  it("tiers appear on /check, /chart.json, merchant pages, llms.txt and openapi", async () => {
    const c = await (await SELF.fetch("https://km.test/check?domain=amazon.com")).json() as Record<string, unknown>;
    expect(c.trust_tier).toBe("unverified"); expect(c.src).toBe("crawler");
    const ch = await (await SELF.fetch("https://km.test/chart.json")).json() as { items: Record<string, unknown>[] };
    if (ch.items.length) expect(ch.items[0]).toHaveProperty("trust_tier");
    const html = await (await SELF.fetch("https://km.test/merchant/amazon.com", { headers: { Accept: "text/html" } })).text();
    expect(html).toContain('data-trust-tier="unverified"');
    const llms = await (await SELF.fetch("https://km.test/llms.txt")).text();
    expect(llms).toMatch(/Trust tiers \(trust_tier\)/); expect(llms).toMatch(/kind 1423/); expect(llms).toMatch(/submit_store/);
    const oa = await (await SELF.fetch("https://km.test/openapi.json")).json() as { paths: Record<string, unknown> };
    expect(oa.paths["/submit"]).toBeTruthy();
  });
});
