import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import signJs from "../../public/km-report-sign.js?raw";
import { rowFlags, flagRow, nonUsStore } from "../src/row-flags";
import { experienceTemplate } from "../src/experience";
import { resolveSub } from "../src/alternatives";
import { checkDomain } from "../src/check";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import REAL from "../../../data/records.ndjson?raw";

describe("/report relays and timing (r5 a)", () => {
  it("no relays prefilled; three one-click suggestions; optional random delay re-signs at publish time", async () => {
    const html = await (await SELF.fetch("https://example.com/report")).text();
    expect(html).toMatch(/id="km-relays" value=""/);
    expect(html.match(/data-add-relay="wss:\/\//g)!.length).toBe(3);
    expect(html).toContain('<option value="1-6">');
    expect(html).toContain('id="km-cancel-delay"');
    expect(signJs).toMatch(/created_at: Math\.floor\(Date\.now\(\) \/ 1000\)[\s\S]*signer\(lastDomain\)/);
    expect(signJs).toMatch(/clearTimeout\(timer\)/);
  });
});

describe("explicit key choice (r5 b)", () => {
  it("per-store mode never silently overrides a pasted key or NIP-07 signer", () => {
    expect(signJs).toMatch(/if \(\$\("km-per-store"\)\.checked && \(state\.mode === "nsec" \|\| state\.mode === "nip07"\) && !\$\("km-per-store"\)\.getAttribute\("data-confirmed"\)\)\s*throw new Error/);
    expect(signJs).toMatch(/state\.mode = "nsec"; ownKeyLoaded\(\)/);
    expect(signJs).toMatch(/state\.mode = "nip07"; ownKeyLoaded\(\)/);
    expect(signJs).toContain('"Signing with " + signerLabel');
  });
});

describe("agent_usable and non-US demotion (r5 c)", () => {
  const card = (o: Record<string, unknown>) => ({ store: { indexed: true, verdict: "reachable", domain: "x.com", ...o } });
  it("usable only after confirmed add-to-cart or the payment step; no-add-to-cart is not usable", () => {
    expect(rowFlags(card({ checkout_stage: "paypage" })).agent_usable).toBe(true);
    expect(rowFlags(card({ checkout_stage: "cart" })).agent_usable).toBe(true);
    expect(rowFlags(card({ checkout_stage: "product" })).agent_usable).toBeNull();
    expect(rowFlags(card({ checkout_stage: null })).agent_usable).toBeNull();
    expect(rowFlags(card({ domain: "focuscamera.com", checkout_stage: "product", first_blocker: "no-add-to-cart" })).agent_usable).toBe(false);
  });
  it("non-US stores get 'may not ship to US' and are demoted when the query has a US ZIP", () => {
    expect(nonUsStore("lottedutyfree.com.au", null)).toMatch(/\.au/);
    expect(nonUsStore("skullcandy.ae", null)).toMatch(/\.ae/);
    expect(nonUsStore("bose.com", null)).toBeNull();
    expect(nonUsStore("brand.co", null)).toBeNull();
    expect(nonUsStore("shop.ca", true)).toBeNull();
    const au = card({ domain: "skullcandy.ae", checkout_stage: "paypage" });
    expect(flagRow(au as never, { usZip: true })).toBe(2);
    expect((au as Record<string, unknown>).may_not_ship_to_us).toBe(true);
    expect(flagRow(card({ domain: "skullcandy.ae", checkout_stage: "paypage" }) as never, {})).toBe(0);
  });
});

describe("note fields (r5 d)", () => {
  it("shipping_source, price_source, strict=1", () => {
    const t = experienceTemplate({ domain: "example.com", depth: "payment", shipping_source: "policy", price_source: "store" }, null);
    expect(t.ok && (t.value.unsigned_event as { tags: string[][] }).tags).toEqual(expect.arrayContaining([["shipping_source", "policy"], ["price_source", "store"]]));
    expect(experienceTemplate({ domain: "example.com", depth: "payment", shipping_source: "guess" }, null).ok).toBe(false);
    expect(experienceTemplate({ domain: "example.com", depth: "payment", colour: "red" }, null).ok).toBe(true);
    const s = experienceTemplate({ domain: "example.com", depth: "payment", colour: "red", strict: "1" }, null);
    expect(s.ok).toBe(false);
  });
  it("strict=1 via the HTTP template is a 400", async () => {
    expect((await SELF.fetch("https://example.com/report/template?domain=example.com&depth=payment&colour=red&strict=1")).status).toBe(400);
  });
});

describe("tip rules documented (r5 e)", () => {
  it("/tips.json and /llms.txt state the 21-sat minimum and history rule", async () => {
    const t = await (await SELF.fetch("https://example.com/tips.json")).json() as { bonus_rules: { min_sats_per_zap: number } };
    expect(t.bonus_rules.min_sats_per_zap).toBe(21);
    const l = await (await SELF.fetch("https://example.com/llms.txt")).text();
    expect(l).toMatch(/at least 21 sats AND a key with history/);
  });
});

describe("/check steps are a list on every path (r5 f)", () => {
  it("checkout_depth.steps and steps are arrays; steps_count is the number", async () => {
    const { rows, report } = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, sourceLabel: "t" });
    const snap = rowsToSnapshot([...rows.values()], report.version, report.source);
    for (const d of ["cryptocloaks.com", "bose.com", "us.soundcore.com"]) {
      const r = checkDomain(snap, d, "https://x");
      const b = (r as { body: Record<string, any> }).body;
      expect(Array.isArray(b.steps), d).toBe(true);
      expect(Array.isArray(b.checkout_depth.steps), d).toBe(true);
      expect(b.checkout_depth.steps_count ?? 0).toBe(b.checkout_depth.steps.length);
    }
  });
});

describe("handbag category (r5 g)", () => {
  it("handbag maps to the handbags sub with an honest note, not plain apparel", async () => {
    expect(resolveSub("handbag")).toEqual({ sub: "handbags", category: "apparel" });
    expect(resolveSub("designer purse")?.sub).toBe("handbags");
    const j = await (await SELF.fetch("https://example.com/alternatives?category=handbag")).json() as Record<string, any>;
    expect(j.sub).toBe("handbags");
    expect(String(j.sub_note)).toMatch(/No indexed store is tagged as selling handbags/);
  });
});
