/** Audit #16/#38 (2026-10-31): one per-store view of agent-commerce protocols (UCP, ACP, AP2), used by /check and /q so they agree.
 * Sources, strongest first: the store's own /.well-known/ucp as KlickyBot read it (ucp-caps.ts, "declared"), the crawl
 * record's ucp probe ("present"/"absent"), agentpay rails, then directory listings (agent-native overlay, "claimed"). */
import { UCP_CAPS } from "./ucp-caps";
import { anOf } from "./agent-native";

export const PROTOCOLS = ["ucp", "acp", "ap2"] as const;
export type Protocol = (typeof PROTOCOLS)[number];
export type ProtoStatus = "declared" | "present" | "claimed" | "absent" | "not-declared" | "unknown";
const YES: ProtoStatus[] = ["declared", "present", "claimed"];

export function protocolsOf(d: string, raw: Record<string, unknown>): Record<Protocol, Record<string, unknown>> {
  const caps = UCP_CAPS[d] ?? UCP_CAPS[d.replace(/^www\./, "")];
  const rec = raw.ucp as { present?: boolean; endpoint?: string | null; src?: string; checked_at?: string } | undefined;
  const ap = Array.isArray(raw.agentpay) ? (raw.agentpay as { rail?: string }[]).map((x) => String(x.rail ?? "").toLowerCase()) : [];
  const an = anOf(d);
  const claimed = (p: string) => !!an?.an_rails.some((r) => r.toLowerCase() === p) || ap.includes(p);
  const ucpStatus: ProtoStatus = caps?.ok ? "declared" : rec?.present === true ? "present" : claimed("ucp") ? "claimed" : rec?.present === false ? "absent" : "unknown";
  const ucp: Record<string, unknown> = { status: ucpStatus, endpoint: rec?.endpoint ?? null, src: caps?.src ?? rec?.src ?? null, checked_at: caps?.checked_at ?? rec?.checked_at ?? null };
  if (caps?.ok) Object.assign(ucp, { version: caps.version ?? null, capabilities: caps.capabilities ?? [], payment_handlers: caps.payment_handlers ?? [], checkout: (caps.capabilities ?? []).includes("dev.ucp.shopping.checkout") });
  else if (caps && !caps.ok) ucp.capabilities_note = `declared capabilities not read: ${caps.why ?? "unknown"}`;
  else if (ucpStatus !== "absent") ucp.capabilities_note = "declared capabilities not read yet";
  const acp: ProtoStatus = caps?.mentions_acp ? "declared" : claimed("acp") ? "claimed" : "unknown";
  const ap2: ProtoStatus = caps?.mentions_ap2 ? "declared" : claimed("ap2") ? "claimed" : caps?.ok ? "not-declared" : "unknown";
  return { ucp, acp: { status: acp, ...(acp === "claimed" ? { note: "listed by a directory; not confirmed from the store's own files" } : {}) },
    ap2: { status: ap2, ...(ap2 === "not-declared" ? { note: "the store's /.well-known/ucp does not mention AP2 mandates" } : {}) } };
}
export const hasProtocol = (p: Record<string, unknown>, k: Protocol) => YES.includes((p[k] as { status: ProtoStatus }).status);
export const PROTOCOLS_NOTE = "status: declared = in the store's own /.well-known/ucp (read by KlickyBot); present = our probe found the UCP file; claimed = listed by a directory or agentpay, not confirmed; absent/not-declared = checked and not there; unknown = not checked.";
