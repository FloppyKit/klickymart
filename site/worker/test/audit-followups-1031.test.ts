/** Customer audit 2026-10-31 follow-ups (#4/#28 and later items). Throwaway local keys only; nothing is published. */
import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";

function sign(tags: string[][], kind = 422, content = "reached payment") {
  const sk = secp.utils.randomSecretKey();
  const ev = { pubkey: bytesToHex(secp.schnorr.getPublicKey(sk)), created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  const id = nostrEventId(ev);
  return { ...ev, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
const post = (ev: unknown, dry = true) => SELF.fetch(`https://klickymart.com/reviews${dry ? "?dry_run=1" : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ev) });

describe("#4/#28 notes about unindexed stores", () => {
  it("dry run accepts an unindexed public domain and marks it pending, not chart-counted", async () => {
    const r = await post(sign([["r", "unindexed-shop-example.com"], ["basis", "visit"], ["depth", "payment"], ["rating", "4", "5"]]));
    const b = await r.json<any>();
    expect(r.status).toBe(200);
    expect(b).toMatchObject({ ok: true, store_indexed: false, counts_toward_chart: false, stored: false });
    expect(b.pending_crawl.status).toBe("pending check");
    expect(b.store_note).toMatch(/robots\.txt first/);
  });
  it("still rejects junk hosts", async () => {
    for (const h of ["localhost", "10.0.0.1", "intranet"]) {
      const b = await (await post(sign([["r", h], ["depth", "browse"]]))).json<any>();
      expect(b.ok, h).toBe(false);
    }
  });
});
