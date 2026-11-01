import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { loadAggregates } from "../src/experience";
import { MIN_RANK_KEY_AGE_S } from "../src/key-age";

// Post-verify bugs (2026-11-01 dogfood of 3466cdf): counts_toward_chart lied for fresh keys; wrong kind said bad_signature.
const D = "store.google.com";
function sign(kind: number, tags: string[][], sk = secp.utils.randomSecretKey()) {
  const ev = { pubkey: bytesToHex(secp.schnorr.getPublicKey(sk)), created_at: Math.floor(Date.now() / 1000), kind, tags, content: "dogfood" };
  const id = nostrEventId(ev); return { ...ev, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
const visit = () => [["r", D], ["basis", "visit"], ["depth", "checkout"], ["rating", "4", "5"]];
const post = (ev: unknown, q = "") => SELF.fetch(`https://example.com/reviews${q}`, { method: "POST", body: JSON.stringify(ev), headers: { "Content-Type": "application/json" } });
type B = { counts_toward_chart: boolean; would_count_toward_chart?: boolean; counts_after?: string; key_age_note?: string; error?: { code: string } };

describe("counts_toward_chart matches the key-age gate", () => {
  it("fresh key: dry run and real post say false with counts_after ~7 days out, and the aggregate agrees", async () => {
    const sk = secp.utils.randomSecretKey(); const nowS = Math.floor(Date.now() / 1000);
    const dry = await (await post(sign(422, visit(), sk), "?dry_run=1")).json<B>();
    expect(dry.counts_toward_chart).toBe(false); expect(dry.would_count_toward_chart).toBe(false);
    const after = Date.parse(dry.counts_after!) / 1000;
    expect(after).toBeGreaterThanOrEqual(nowS + MIN_RANK_KEY_AGE_S); expect(after).toBeLessThanOrEqual(nowS + MIN_RANK_KEY_AGE_S + 86400);
    expect(dry.key_age_note).toMatch(/7 days/);
    const res = await post(sign(422, visit(), sk)); expect(res.status).toBe(201);
    const j = await res.json<B>(); expect(j.counts_toward_chart).toBe(false); expect(j.counts_after).toBe(dry.counts_after);
    const pk = bytesToHex(secp.schnorr.getPublicKey(sk));
    const a = (await loadAggregates(env.DB, [D])).get(D); expect(a?.keys ?? 0).toBe(0);
    // once the key is old by ingest time, the next note from it says true and the aggregate counts it
    await env.DB.prepare("UPDATE experiences SET received_day = '2026-01-01' WHERE pubkey = ?").bind(pk).run();
    const j2 = await (await post(sign(422, visit().concat([["depth", "paid"]]).filter((t, i, arr) => arr.findIndex((x) => x[0] === t[0]) === i), sk))).json<B>();
    expect(j2.counts_toward_chart).toBe(true); expect(j2.counts_after).toBeUndefined();
    expect((await loadAggregates(env.DB, [D])).get(D)?.keys).toBe(1);
  });
  it("non-visit basis stays false with no counts_after", async () => {
    const j = await (await post(sign(422, [["r", D], ["basis", "directory"], ["depth", "cart"]]), "?dry_run=1")).json<B>();
    expect(j.counts_toward_chart).toBe(false); expect(j.counts_after).toBeUndefined();
  });
});

describe("wrong kind on POST /reviews", () => {
  it("kind 420 returns bad_kind, not bad_signature; a tampered 422 still returns bad_signature", async () => {
    const r = await post(sign(420, [["r", D], ["t", "klickymart"]])); expect(r.status).toBe(400);
    expect((await r.json<B>()).error?.code).toBe("bad_kind");
    const t = { ...sign(422, visit()), content: "tampered" };
    expect((await (await post(t)).json<B>()).error?.code).toBe("bad_signature");
  });
});
