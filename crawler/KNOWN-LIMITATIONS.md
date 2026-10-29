# Known limitations and findings (draft, 2026-10-29)

## Single datacenter IP
All crawls (pilot 1, pilot 2, the 2026-10-29 --force re-run and the ToS test) ran from one IP: the shared box's cloud/datacenter address. Many bot-management products (Cloudflare, Akamai, PerimeterX/HUMAN) score datacenter IPs as more suspicious than residential ones, so some blocks we record may be caused partly by the IP rather than the user agent or the browser.

How we treat it:
- A block seen from this IP is recorded as a finding (`ar` entry with evidence), not worked around. It is a real result: it is what an agent running in the cloud will hit.
- No proxies, no residential IPs, no IP rotation, no retries from other addresses.
- Records should say where they were crawled from. Every record carries `vantage: {"ip":"single-datacenter",...}` (added 2026-10-29).
- Published numbers must say "from one datacenter IP" next to any block rate.

## Other limitations
- Payment scope (online vs in-store) is detected from wording and section headings only; when a page does not say, scope stays null (`pay_unscoped`).
- ToS classification is a regex over the terms page. `ok` means "no automation clause matched", not legal clearance; `null` means unknown.
- The UGC filter uses DOM class/id names and text shape. Reviews rendered with unusual markup may still get through; review-only hits on non-payment pages are low confidence.
