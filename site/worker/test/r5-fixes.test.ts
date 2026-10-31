import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import signJs from "../../public/km-report-sign.js?raw";
import { summarize, tipWeight, type Tip } from "../src/tips";
import { experienceTemplate, proofWeight } from "../src/experience";
import { findRow, registrable } from "../src/store-card";
import { payNotObserved } from "../src/check";
import { checkProof, type Ev } from "../src/relay-ingest";
import { FACILITATOR_PUBKEY } from "../src/facilitate";

describe("/report publish safety (Blair r5)", () => {
  it("two-step publish: review shows relays + signed event; confirm is disabled until the box is ticked", async () => {
    const html = await (await SELF.fetch("https://example.com/report")).text();
    expect(html).toContain('id="km-publish">Review before publishing');
    expect(html).toMatch(/id="km-confirm-publish" disabled/);
    expect(html).toContain('id="km-confirm-relays"');
    expect(html).toContain('id="km-confirm-event"');
    // pool.publish only runs inside the confirm handler, which re-checks the tick box
    const pub = signJs.indexOf("pool.publish(");
    const confirm = signJs.indexOf('$("km-confirm-publish").onclick');
    expect(pub).toBeGreaterThan(confirm);
    expect(signJs.slice(confirm, pub)).toContain('$("km-confirm-ok").checked');
    expect(signJs.match(/pool\.publish\(/g)!.length).toBe(1);
  });
  it("new secret hidden by default; show once; download/hide clear the field and revoke the blob URL", async () => {
    const html = await (await SELF.fetch("https://example.com/report")).text();
    expect(html).toMatch(/id="km-nsec" type="password"/);
    expect(html).toContain('id="km-show-nsec"');
    expect(signJs).toMatch(/function clearNsec\(\) \{[\s\S]*?value = ""[\s\S]*?revokeObjectURL/);
    expect(signJs).toMatch(/km-nsec-dl"\)\.onclick = function \(\) \{[^}]*setTimeout\(clearNsec/);
    expect(signJs).toMatch(/km-show-nsec"\)\.onclick[^}]*disabled = true/);
  });
  it("strict CSP: no inline script, only same-origin scripts, connect-src = self + listed relays", async () => {
    const r = await SELF.fetch("https://example.com/report");
    const csp = r.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'self';/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toMatch(/connect-src 'self' wss:\/\/relay\.damus\.io wss:\/\/nos\.lol wss:\/\/relay\.primal\.net;/);
    expect(csp).not.toMatch(/connect-src[^;]*wss: /);
    const html = await r.text();
    expect(html.match(/<script(?![^>]*\ssrc=)[^>]*>/g) ?? []).toEqual([]);
    for (const m of html.matchAll(/<script[^>]*src="([^"]+)"/g)) expect(m[1]!.startsWith("/")).toBe(true);
  });
});

const tip = (tipper: string, sats: number, eligible: boolean): Tip => ({ receipt: tipper + sats, target: "n", tipper, sats, validated: true, self: false, created_at: 1, eligible });
describe("tip bonus resists dust (Blair r5)", () => {
  it("20 throwaway dust tippers move the bonus by ~0; real tippers still count", () => {
    const dust = Array.from({ length: 20 }, (_, i) => tip(`dust${i}`, 1, false));
    expect(summarize(dust).weight).toBe(1);
    expect(summarize(Array.from({ length: 20 }, (_, i) => tip(`big-new${i}`, 1000, false))).weight).toBe(1); // no history
    expect(summarize(Array.from({ length: 20 }, (_, i) => tip(`old-dust${i}`, 20, true))).weight).toBe(1);   // below 21 sats
    const real = [tip("a", 21, true), tip("b", 500, true)];
    expect(summarize([...dust, ...real]).weight).toBeCloseTo(tipWeight(2));
    expect(summarize([...dust, ...real]).tips).toBe(22); // still shown
  });
});

describe("note schema (r5)", () => {
  it("fee=unknown is accepted (not a 400) and kept as unknown, not zero", async () => {
    const t = experienceTemplate({ domain: "bitrefill.com", depth: "payment", fee: "unknown", price_seen: "26.55" }, null);
    expect(t.ok).toBe(true);
    expect(t.ok && (t.value.unsigned_event as { tags: string[][] }).tags).toContainEqual(["amount", "fee", "unknown", "USD"]);
    const r = await SELF.fetch("https://example.com/report/template?domain=example.com&depth=payment&fee=unknown");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { param_help: Record<string, string> }).param_help.estimated).toMatch(/true/);
  });
  it("estimated accepts a boolean or a list", () => {
    const tags = (a: Record<string, unknown>) => { const t = experienceTemplate({ domain: "example.com", depth: "payment", tax: "1.5", total: "20", ...a }, null); return t.ok ? (t.value.unsigned_event as { tags: string[][] }).tags.filter((x) => x[0] === "amount") : []; };
    expect(tags({ estimated: true }).every((x) => x[4] === "estimated")).toBe(true);
    expect(tags({ estimated: "true" }).every((x) => x[4] === "estimated")).toBe(true);
    expect(tags({ estimated: false }).some((x) => x[4] === "estimated")).toBe(false);
    expect(tags({ estimated: ["tax"] }).find((x) => x[1] === "tax")![4]).toBe("estimated");
    expect(tags({ estimated: "tax" }).find((x) => x[1] === "total")![4]).toBeUndefined();
  });
});

describe("store lookup across subdomains (ShopBot r5)", () => {
  const snap = { rows: [{ d: "us.soundcore.com" }, { d: "bose.com" }, { d: "shop.example.co.uk" }] } as never;
  it("soundcore.com and its other subdomains find us.soundcore.com; unrelated domains do not", () => {
    expect(findRow(snap, "soundcore.com")?.d).toBe("us.soundcore.com");
    expect(findRow(snap, "www.soundcore.com")?.d).toBe("us.soundcore.com");
    expect(findRow(snap, "https://uk.soundcore.com/products/x")?.d).toBe("us.soundcore.com");
    expect(findRow(snap, "www.bose.com")?.d).toBe("bose.com");
    expect(findRow(snap, "example.co.uk")?.d).toBe("shop.example.co.uk");
    expect(findRow(snap, "notsoundcore.com")).toBeNull();
    expect(registrable("a.b.example.com.au")).toBe("example.com.au");
  });
  it("/check resolves soundcore.com to the indexed subdomain (or says not-in-index only when none exists)", async () => {
    const j = await (await SELF.fetch("https://example.com/check?domain=nonexistent-zz.example")).json() as { verdict: string };
    expect(j.verdict).toBe("not-in-index");
  });
  it("empty pay list with no pay source is labelled not-observed (bose.com data gap), not 'none'", () => {
    expect(payNotObserved({ pay: [], pay_online: [], pay_instore: [], pay_unscoped: [], pay_src: null })).toBe(true);
    expect(payNotObserved({ pay: [], pay_src: "checkout" })).toBe(false);
    expect(payNotObserved({ pay: ["card"] })).toBe(false);
  });
});

describe("facilitated unverified-claim weight (ShopBot r5)", () => {
  it("a 422 citing a hash-only facilitated 421 gets plain-note weight (1), no proof bonus", () => {
    const ful = { id: "f".repeat(64), pubkey: FACILITATOR_PUBKEY, kind: 421, created_at: 1, content: "", sig: "", tags: [["verification", "unverified-claim"], ["proof", "order_hash", "ab".repeat(32)]] } as Ev;
    const rv = { id: "a".repeat(64), pubkey: "b".repeat(64), kind: 422, created_at: 1, content: "", sig: "", tags: [["e", ful.id, "", "fulfillment"], ["order_hash", "ab".repeat(32)]] } as Ev;
    const st = checkProof(rv, ful, null);
    expect(st).toBe("facilitated-unverified");
    expect(proofWeight("order_hash", st)).toBe(1);
    expect(proofWeight(null, null)).toBe(1);
    // R12-101: a plain attached (unchecked) proof gets plain-note weight too
    expect(proofWeight("order_hash", "unverified-claim")).toBe(1);
  });
});
