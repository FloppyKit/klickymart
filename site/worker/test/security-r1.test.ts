import { describe, expect, it, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { insertAfterH1 } from "../src/router";
import { revokeFacilitated, FACILITATOR_PUBKEY } from "../src/facilitate";

describe("KM-R1-001: merchant badge splice", () => {
  it("$-patterns in merchant text are inserted literally, not expanded", () => {
    const html = "<header>HDR</header><h1>Shop</h1><main>body</main>";
    const evil = '<span title="$` $& $\' $1">x</span>';
    const out = insertAfterH1(html, evil);
    expect(out).toBe(`<header>HDR</header><h1>Shop</h1>${evil}<main>body</main>`);
    expect(out.match(/HDR/g)?.length).toBe(1);
  });
});

describe("KM-002 follow-up: revoke facilitated 421s", () => {
  beforeEach(async () => { for (const t of ["revoked_events", "experiences", "nostr_events"]) await env.DB.prepare(`DELETE FROM ${t}`).run(); });
  it("demotes notes that used a pre-pause facilitated 421 as proof and records the revocation", async () => {
    const ful = "f1".repeat(32), note = "a2".repeat(32), pk = "b3".repeat(32);
    await env.DB.prepare("INSERT INTO nostr_events (id,kind,pubkey,created_at,d,raw_json,first_seen,relays) VALUES (?,421,?,1,'rv.example','{}',1,'')").bind(ful, FACILITATOR_PUBKEY).run();
    await env.DB.prepare("INSERT INTO experiences (id,kind,d,pubkey,created_at,structured,content,raw_json,source,received_day,basis,proof_status) VALUES (?,422,'rv.example',?,1,1,'',?,'post','2026-10-30','visit','verified-preimage')").bind(note, pk, JSON.stringify({ tags: [["e", ful, "", "fulfillment"]] })).run();
    const r = await revokeFacilitated(env.DB);
    expect(r).toEqual({ revoked: 1, demoted: 1 });
    expect((await env.DB.prepare("SELECT proof_status FROM experiences WHERE id = ?").bind(note).first<{ proof_status: string }>())?.proof_status).toBe("facilitated-unverified");
    expect(await revokeFacilitated(env.DB)).toEqual({ revoked: 0, demoted: 0 });
  });
});

describe("minor P2s", () => {
  it("openapi documents the 503 for GET /facilitate", async () => {
    const o = await (await SELF.fetch("https://example.com/openapi.json")).json() as { paths: Record<string, { get?: { responses: Record<string, unknown> } }> };
    expect(o.paths["/facilitate"]?.get?.responses?.["503"]).toBeTruthy();
  });
});
