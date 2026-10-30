import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import JS from "../../public/km-report-sign.js?raw";
import NT from "../../public/vendor/nostr-tools-2.17.0.bundle.js?raw";
import { NOSTR_TOOLS_SRI, REPORT_SIGN_SRI } from "../src/render/pages";

const js = JS as string;
// Run the page script with a fake window (no #km-sign element => only the pure helpers are set up).
function helpers() {
  const win: Record<string, any> = { NostrTools: {} };
  new Function("window", "document", js)(win, { getElementById: () => null });
  return win.KMSign as { publicEvent: (e: any) => any; templateQuery: (f: Record<string, string>) => string };
}

describe("/report in-browser signing never sends a secret key", () => {
  it("only three network paths exist: GET template, POST dry-run, relay publish; no storage/beacons/analytics", () => {
    const fetches = [...js.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1]!.trim());
    expect(fetches).toEqual(['"/report/template?" + templateQuery(f', '"/reviews?dry_run=1"']);
    expect(js).toMatch(/body: JSON\.stringify\(publicEvent\(signed\)\)/);
    expect(js).toMatch(/pool\.publish\(relays, ev\)/); expect(js).toMatch(/var ev = publicEvent\(signed\)/);
    for (const bad of ["XMLHttpRequest", "sendBeacon", "localStorage", "sessionStorage", "document.cookie", "console.log", "gtag", "analytics", "navigator.clipboard", "postMessage", "new Image", "WebSocket("])
      expect(js.includes(bad), bad).toBe(false);
  });
  it("templateQuery drops key fields; publicEvent keeps only event fields and refuses an nsec", () => {
    const h = helpers();
    const q = h.templateQuery({ domain: "a.com", depth: "cart", nsec: "nsec1abc", sk: "00", private_key: "x", privkey: "y", secret: "z" });
    expect(q).toBe("domain=a.com&depth=cart");
    const ev = { id: "1", pubkey: "p", created_at: 1, kind: 422, tags: [], content: "c", sig: "s", nsec: "nsec1zzz", sk: "00", privkey: "k" };
    expect(Object.keys(h.publicEvent(ev)).sort()).toEqual(["content", "created_at", "id", "kind", "pubkey", "sig", "tags"]);
    expect(() => h.publicEvent({ ...ev, content: "my key nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" })).toThrow(/nsec/);
  });
  it("/report serves the signer with SRI and a CSP that limits network to self + wss relays", async () => {
    const r = await SELF.fetch("https://example.com/report");
    const html = await r.text();
    expect(html).toContain(`integrity="${NOSTR_TOOLS_SRI}"`); expect(html).toContain(`integrity="${REPORT_SIGN_SRI}"`);
    expect(html).toContain("Create my agent key"); expect(html).toContain("Per-store key");
    expect(r.headers.get("Content-Security-Policy")).toMatch(/connect-src 'self' wss:/);
  });
  it("SRI hashes match the files in public/", async () => {
    const sri = async (text: string) => { const d = new Uint8Array(await crypto.subtle.digest("SHA-384", new TextEncoder().encode(text))); let b = ""; for (const x of d) b += String.fromCharCode(x); return "sha384-" + btoa(b); };
    expect(await sri(JS as string)).toBe(REPORT_SIGN_SRI);
    expect(await sri(NT as string)).toBe(NOSTR_TOOLS_SRI);
  });
});
