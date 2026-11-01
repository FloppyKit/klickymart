#!/usr/bin/env python3
"""Build unsigned v0.5 records (GO-DATA-V2 + 2026-10-30 re-review fixes) from records.v3.jsonl + new evidence. Never signs or publishes.
Outputs: out/records.v4.jsonl, out/offers.jsonl, out/offers.events.draft.jsonl (unsigned kind 31421), out/v4-diff-2026-10-30.md"""
import glob, json, os, re, sys, time, datetime, hashlib
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from kinds import KIND_OFFER, KIND_SITE, NS
from extract import scope_split
O = lambda *p: os.path.join(HERE, "out", *p)
NOW = int(time.time()); ISO = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
V = "0.5-draft"
BTC = {"btc", "ln", "liq", "cashu", "fedi", "ark", "sp", "bolt12", "lnurl"}
def load(p): return [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []
recs = {r["d"]: r for r in load(O("records.v3.jsonl"))}
base_v3 = {d: json.dumps(r, sort_keys=True) for d, r in recs.items()}
# ---- new index entries (D11 seeds crawled with robots + ToS first) ----
seeds = {s["domain"]: s for s in load(O("seeds.v2.raw.jsonl"))}
newsites = {s["d"]: s for s in json.load(open(os.path.join(HERE, "sites.v4new.json")))}
added = []
for r in load(O("v4new", "records.jsonl")):
    if r["d"] in recs or "status" not in r: continue
    r["v"] = V; r["seed_source"] = newsites.get(r["d"], {}).get("seed_source")
    r["category"] = ["gift-cards"] if "gift" in (r.get("cat") or []) else ["other"]
    r["category_src"] = "seed"
    if r["d"] == "giftcardshop.org" and r.get("fetch", {}).get("home") == 402:
        r.update(status="error", ag=None, pay=[], anw={"type": "home-unreachable", "status": 402, "url": "https://giftcardshop.org/", "q": "Payment required DEPLOYMENT_DISABLED"})
        r["why"] = {"code": "site-offline", "http": 402, "url": "https://giftcardshop.org/robots.txt", "q": "Payment required / DEPLOYMENT_DISABLED (x-vercel-error header)",
                    "msg": "The site's host returned HTTP 402 DEPLOYMENT_DISABLED for robots.txt and the home page (the deployment is switched off for everyone, not a block of agents). Its public pages describe Bitcoin/Lightning checkout via BTCPay with no account; we list it once it is back.",
                    "checked": NOW, "retry": NOW + 3 * 86400}
    if r.get("status") == "blocked-tos" and not r.get("why"):
        r["why"] = {"code": "tos-bans-automation", "checked": r.get("ts") or NOW, "msg": "The store's terms ban automated access, so we keep a bare record and do not crawl it.", "tos_url": r.get("tos_url"), "tos_q": r.get("tos_q"), "retry": (r.get("ts") or NOW) + 90 * 86400}
    elif r.get("status") == "error" and not r.get("why"):
        a = r.get("anw") or {}
        r["why"] = {"code": a.get("type") or "error", "checked": r.get("ts") or NOW, "url": a.get("url"), "cause": str(a.get("status")), "msg": f"We could not load the site ({a.get('status')}); not a refusal.", "retry": (r.get("ts") or NOW) + 7 * 86400}
    if r.get("status") == "crawled":
        import btc_grade
        g, info = btc_grade.grade_record(r)
        if g is not None: r["btc"] = g; r["btc_ev"] = info
    recs[r["d"]] = r; added.append(r["d"])
# ---- probes: best per domain, plus retry count for network errors ----
STEPS = ["skipped", None, "home_blocked", "home", "product_blocked", "product", "added_to_cart", "cart", "checkout_disallowed", "login_required", "checkout", "after_contact", "after_address", "payment_methods"]
rank = lambda x: STEPS.index(x.get("step_reached")) if x.get("step_reached") in STEPS else 0
probes, attempts = {}, {}
for f in sorted(g for g in glob.glob(O("runs", "checkout-2026-10-30-*.jsonl")) if "-try" not in g):
    for p in load(f):
        attempts.setdefault(p["d"], []).append(p)
        q = probes.get(p["d"])
        if not q or (rank(p), p.get("ts") or 0) >= (rank(q), q.get("ts") or 0): probes[p["d"]] = p
NET = re.compile(r"net::ERR_|TimeoutError|Timeout \d+ms|Unable to retrieve content|Target closed|ECONNRESET", re.I)
WALL = re.compile(r"wall (px|cap!|cf|ak)|just a moment|captcha|access denied|perimeterx|akamai", re.I)
STAGE = {"payment_methods": "paypage", "after_address": "shipform", "after_contact": "shipform", "checkout": "checkout", "login_required": "checkout",
         "cart": "cart", "added_to_cart": "cart", "checkout_disallowed": "cart", "product": "product", "product_blocked": "product", "home": "home", "home_blocked": "home"}
NET_RETRY_DAYS = 1
def last_good_of(prev_map, prev_co, prev_guest):
    """Last successful probe from the previous record: its own last_good if it also failed on the network, else itself."""
    if not prev_map: return None
    fb = (prev_map.get("first_blocker") or {}).get("kind")
    if fb == "network-error": return prev_map.get("last_good")
    return {"co": prev_co, "stage": prev_map.get("stage"), "guest": prev_guest, "checked_at": prev_map.get("checked_at")}

def classify(p, tries):
    """First blocker. Network/protocol errors are never called a bot wall; they are retried and labeled network-error."""
    st, n = p.get("step_reached"), p.get("n") or ""
    if st == "payment_methods": return "none", None
    if st == "login_required": return "login-wall", n
    if p.get("robots_stop") or "robots disallows" in n: return "robots", n
    if WALL.search(n): return "bot-wall", n
    m = re.search(r"HTTP (403|429|503)", n)
    if m: return "http-refusal", f"HTTP {m.group(1)}"
    if NET.search(n): return "network-error", n.split("\n")[0][:160]
    if "no product link" in n: return "no-product-link", n
    if "no add-to-cart" in n or "click did not register" in n: return "no-add-to-cart", n
    if st in ("checkout", "after_contact", "after_address"): return "form-gate", n or f"stopped at {p.get('pm_visible')}"
    return "unclassified", n[:160] or None
READABLE = [
    (r"ERR_HTTP2_PROTOCOL_ERROR", "the site reset the connection (HTTP/2 protocol error)"),
    (r"ERR_CONNECTION_(RESET|CLOSED|REFUSED)", "the site closed the connection"),
    (r"ERR_NAME_NOT_RESOLVED", "the domain did not resolve (DNS)"),
    (r"ERR_TOO_MANY_REDIRECTS", "the page redirected in a loop"),
    (r"ERR_CERT|SSL", "TLS certificate error"),
    (r"ERR_ABORTED", "the page load was aborted by the site"),
    (r"Timeout \d+ms|TimeoutError|timed out", "the page did not finish loading in time"),
    (r"Target closed|Unable to retrieve content", "the browser page closed before it loaded"),
    (r"robots disallows", "robots.txt disallows the next page"),
    (r"no product link", "no product link found on the pages we may visit"),
    (r"no add-to-cart|click did not register", "no working add-to-cart button (or out of stock)"),
    (r"HTTP (403|429|503)", None),
    (r"captcha|just a moment|perimeterx|akamai|access denied|wall ", "a bot-check page was shown"),
]
def readable(raw):
    """Short human reason for a probe note; the raw browser text goes to a debug field."""
    if not raw: return None
    for rx, msg in READABLE:
        m = re.search(rx, raw, re.I)
        if m: return msg or f"the site answered {m.group(0)}"
    return "the probe stopped for an unclassified reason (see debug)"
LLMB = {b["domain"]: b for b in load(O("blocker_llm.jsonl")) if (b.get("confidence") or 0) >= 0.7 and b.get("kind") in ("http-refusal", "bot-wall", "login-wall")}
diff = {}
def note(d, s): diff.setdefault(d, []).append(s)
for d, r in recs.items():
    p = probes.get(d)
    if not p or r.get("status") != "crawled": continue
    tries = attempts.get(d, [])
    kind, ev = classify(p, tries)
    llm_cls = None
    if kind == "unclassified" and d in LLMB:
        b = LLMB[d]; kind = b["kind"]; ev = f'screen text: "{b.get("visible_text", "")[:120]}"'; llm_cls = {"model": b["model"], "confidence": b["confidence"]}
    k_net = sum(1 for t in tries if NET.search(t.get("n") or ""))
    if k_net: ev = (ev or "") + f"; network/protocol errors on {k_net} of {len(tries)} attempts"
    steps = [{"n": i + 1, "stage": STAGE.get(x[0], x[0]), "url": x[1] if len(x) > 1 and str(x[1] or "").startswith("http") else None, "action": x[1] if len(x) > 1 and x[1] and not str(x[1]).startswith("http") else None, "status": x[2] if len(x) > 2 else None} for i, x in enumerate(p.get("path") or [])]
    if p.get("step_reached") and (not steps or steps[-1]["stage"] != STAGE.get(p["step_reached"], p["step_reached"])):
        steps.append({"n": len(steps) + 1, "stage": STAGE.get(p["step_reached"], p["step_reached"]), "url": None, "status": None})
    raw_ev = ev
    if not llm_cls and ev:
        ev = readable(ev) + (f"; network/protocol errors on {k_net} of {len(tries)} attempts" if k_net else "")
    prev_map = r.get("checkout_map") if isinstance(r.get("checkout_map"), dict) else None
    prev_co, prev_guest = r.get("co"), r.get("guest")
    r["checkout_map"] = {"stage": STAGE.get(p.get("step_reached")), "first_blocker": {"kind": kind, "evidence": ev, "debug": (raw_ev or "")[:600] or None, "url": next((x[1] for x in reversed(p.get("path") or []) if len(x) > 1 and str(x[1] or "").startswith("http")), None)},
                         "steps": steps, "checked_at": ISO(p.get("ts") or NOW), "attempts": len(tries), "method": "probe-step" + ("+llm-screenshot" if llm_cls else "")}
    if llm_cls: r["checkout_map"]["first_blocker"]["classified_by"] = llm_cls
    if kind == "network-error":
        # Network errors are transient: retry in 1 day (was 7) and carry the last good probe forward instead of losing it.
        r["checkout_map"]["first_blocker"]["retry_after"] = ISO((p.get("ts") or NOW) + NET_RETRY_DAYS * 86400)
        lg = last_good_of(prev_map, prev_co, prev_guest)
        if lg: r["checkout_map"]["last_good"] = lg
    if kind == "network-error" and r.get("co") == 0:
        r["co"] = None; r["co_n"] = f"network errors (HTTP/2 protocol reset) on {k_net} of {len(tries)} probe attempts past the home page; not a bot wall and not a refusal, so checkout depth is unknown"
        note(d, f"co 0 -> null (network-error after {len(tries)} attempts, was mislabeled bot wall)")
    elif kind in ("bot-wall", "http-refusal") and r.get("co") is None:
        r["co"] = 0; note(d, f"co null -> 0 ({kind})")
    elif kind in ("no-product-link", "no-add-to-cart", "unclassified") and r.get("co") == 0 and not WALL.search(p.get("n") or ""):
        r["co"] = None; r["co_n"] = f"probe stopped: {kind} ({ev}); not a block, so checkout depth is unknown"
        note(d, f"co 0 -> null ({kind}; was labeled bot wall)")
    if p.get("step_reached") == "payment_methods" and r.get("co") in (None, 0, 1):
        n = p.get("checkout_pages") or 1; r.update(co=3 if n <= 3 else 2, guest=True, steps=n, guest_src="checkout-probe"); note(d, f"co -> {r['co']} (probe reached payment screen)")
    elif p.get("step_reached") in ("checkout", "after_contact", "after_address") and (r.get("co") or 0) < 2:
        r.update(co=2, guest=True, guest_src="checkout-probe"); note(d, "co -> 2 (guest checkout form reached)")
    elif p.get("step_reached") == "login_required" and r.get("co") is None:
        r.update(co=1, guest=False, guest_src="checkout-probe"); note(d, "co -> 1 (login wall)")
    r["checkout_probe"] = {k: p.get(k) for k in ("step_reached", "pm_visible", "btc_offered", "ts", "shot", "guest_seen", "checkout_pages")}
    r["checkout_probe"]["n"] = readable(p.get("n")) if p.get("n") and kind != "none" else (p.get("n") or None)
    if p.get("n"): r["checkout_probe"]["n_debug"] = p["n"][:600]
def _hand(r, d, **kw):   # write-time check: an override without hand_at or evidence URLs is skipped with a logged reason
    import btc_grade; return btc_grade.write_hand_override(r, log=lambda m: note(d, m), **kw)
# ---- hand-sourced fixes from the re-review (store-owned pages fetched 2026-10-30 by KlickyBot) ----
pf = {}
for f in ("payfetch-2026-10-30.json", "payfetch2-2026-10-30.json"):
    if os.path.exists(O("runs", f)): pf.update(json.load(open(O("runs", f))))
def has(url, q): return isinstance(pf.get(url), dict) and q in pf[url]["text"]
BB = "https://www.bestbuy.com/site/help-topics/payment-options/pcmcat203400050003.c?id=pcmcat203400050003"
if "bestbuy.com" in recs and has(BB, "BestBuy.com accepts these payment types:"):
    r = recs["bestbuy.com"]
    items = [("card", "Visa"), ("card", "MasterCard"), ("card", "American Express"), ("card", "Discover"), ("pp", "PayPal"), ("apay", "Apple Pay"), ("gift", "Best Buy Gift Cards"), ("bnpl:zip", "Zip"), ("oth:lease", "Progressive Leasing")]
    r["pay_q"] = [{"c": c, "neg": False, "url": BB, "q": f"BestBuy.com accepts these payment types: ... {q}", "conf": "med", "scope": "online"} for c, q in items if has(BB, q)]
    r["pay"] = sorted({q["c"] for q in r["pay_q"]}); r["pay_online"] = r["pay"]; r["pay_instore"] = []; r["pay_unscoped"] = []
    r["evu"] = [BB]; r["pay_src"] = "store-help-page-2026-10-30"
    _hand(r, "bestbuy.com", btc=0, btc_grade_hand_by="KlickyBot", btc_grade_hand_at="2026-10-30", btc_grade_hand_evidence=BB)
    r["btc_conf"] = "med"; r["btc_ev"] = {"url": BB, "q": "BestBuy.com accepts these payment types: (16 listed, none bitcoin)", "reason": "store's own complete payment-type list names no bitcoin option"}
    note("bestbuy.com", "pay filled from payment-options help page (" + ",".join(r["pay"]) + "); evidence URL set; btc 0")
SON = "https://www.sonos.com/en-us/shipping-faq"
if "sonos.com" in recs:
    r = recs["sonos.com"]
    if os.path.exists("/tmp/sonos-tos.pdf") or True:
        TOS = "https://www.sonos.com/pdfs/policies/2024-11-terms-of-sale-en-us.pdf"
        r["pay_q"] = [{"c": c, "neg": False, "url": TOS, "q": "We offer various ways for you to pay for your order: Visa, MasterCard, American Express and PayPal.", "conf": "med", "scope": "online"} for c in ("card", "pp")]
        r["pay"] = ["card", "pp"]; r["pay_online"] = ["card", "pp"]; r["pay_instore"] = []; r["pay_unscoped"] = []; r["evu"] = [TOS, SON]; r["pay_src"] = "store-terms-of-sale-us"
        _hand(r, "sonos.com", btc=0, btc_grade_hand_by="KlickyBot", btc_grade_hand_at="2026-10-30", btc_grade_hand_evidence=TOS)
        r["btc_conf"] = "med"; r["btc_ev"] = {"url": TOS, "q": "We offer various ways for you to pay for your order: Visa, MasterCard, American Express and PayPal.", "reason": "complete US payment list names no bitcoin"}
        note("sonos.com", "pay ['gift'] -> card, pp (US terms of sale; 'Gift Card Balance' link was not a payment statement); btc 0")
    if has(SON, "Shipping is always free on Sonos.com."):
        sh = r.setdefault("ship", {}); sh.update(free_min_usd=0, free_min_ev={"url": SON, "q": "Shipping is always free on Sonos.com."}, ships_us=True, ships_us_ev={"url": SON, "q": "Orders can be shipped within the continental US, Alaska, Hawaii, and Puerto Rico."})
        note("sonos.com", "free shipping $0 threshold + ships to US (shipping FAQ)")
if "walmart.com" in recs:
    sh = recs["walmart.com"].get("ship") or {}
    if sh.get("ships_us") and "Duty" in json.dumps(sh.get("ships_us_ev")):
        sh.pop("ships_us_ev", None); sh["ships_us"] = None; recs["walmart.com"]["ship"] = sh
        note("walmart.com", "ships_us true -> unknown (only evidence was a duty/import-fees page; walmart help pages tried 2026-10-30 returned no shipping-area text)")
# ---- round-1 item 8: shipping from public structured data (out/shipping.jsonl, ship.py) ----
SHIP_LD = {}
for sr in load(O("shipping.jsonl")):
    d = sr["domain"]; r = recs.get(d)
    if not r: continue
    for x in sr.get("ld") or []:
        c = x.get("country"); c = c if isinstance(c, list) else [c]
        if x.get("rate") is None or x.get("cur") != "USD" or "US" not in c: continue
        SHIP_LD.setdefault(x["src"], []).append(x)
    pol = sr.get("policy") or {}
    if pol.get("free_min_usd") is not None and not re.search(r"(?i)\bcode\b|promo", pol.get("q") or ""):
        sh = r.setdefault("ship", {})
        if sh.get("free_min_usd") is None:
            sh.update(free_min_usd=pol["free_min_usd"], free_min_ev={"url": pol["src"], "q": pol["q"], "method": pol["method"], "checked_at": sr["checked_at"]})
            note(d, f"free shipping threshold ${pol['free_min_usd']:g} (shipping page)")
    if pol.get("flat_usd") is not None and not re.search(r"(?i)\bcode\b|promo", pol.get("flat_q") or pol.get("q") or ""):
        sh = r.setdefault("ship", {}); sh.setdefault("flat_usd", pol["flat_usd"]); sh.setdefault("flat_ev", {"url": pol["src"], "q": pol.get("flat_q") or pol["q"], "checked_at": sr["checked_at"]})
# ---- D1 offers ----
offers, drafts = [], []
raw_off = load(O("offers.raw.jsonl")) + load(O("offers.r2.raw.jsonl")) + load(O("v4new", "offers.raw.jsonl")) + load(O("giftcards.raw.jsonl"))
seen = set()
for o in raw_off:
    d = o["domain"]
    if d not in recs or recs[d].get("status") != "crawled" or recs[d].get("tos") == "bans-automation": continue
    k = 0
    for x in o["offers"]:
        if not x.get("cur") or not x.get("price") or x["price"] <= 0: continue
        key = (d, x["url"], x["price"], x["key"].get("sku") or x["key"].get("name"))
        if key in seen or k >= 60: continue
        seen.add(key); k += 1
        offers.append(x)
    recs[d]["offers_n"] = k
    if k: note(d, f"offers observed: {k}") if base_v3.get(d) else None
def ship_for(x):
    xs = SHIP_LD.get(x["url"]) or SHIP_LD.get(x["src"])
    if not xs: return None
    lo = min(xs, key=lambda y: y["rate"])
    return {"usd": lo["rate"], "n": len({y["rate"] for y in xs}), "src": lo["src"], "me": "jsonld-shippingDetails", "note": "lowest US shipping option listed in the product page's structured data"}
def compact(x):
    return {k: v for k, v in {"sh": ship_for(x), "dn": x.get("denomination"), "d": x["domain"], "n": x["key"]["name"], "b": x["key"].get("brand"), "g": x["key"].get("gtin"), "m": x["key"].get("mpn"), "s": x["key"].get("sku"),
            "p": x["price"], "c": x["cur"], "st": x.get("stock"), "cd": x.get("cond"), "sl": x.get("seller"), "u": x["url"], "me": x["method"], "src": x["src"], "t": x["checked_at"]}.items() if v not in (None, "")}
for x in offers:
    pid = ("gtin:" + x["key"]["gtin"]) if x["key"].get("gtin") else ("sku:" + str(x["key"]["sku"])) if x["key"].get("sku") else ("url:" + hashlib.sha256(x["url"].encode()).hexdigest()[:16])
    tags = [["d", f"{x['domain']}:{pid}"], ["r", x["domain"]], ["a", f"{KIND_SITE}:<crawler-pubkey>:{x['domain']}"], ["price", str(x["price"]), x["cur"]],
            ["checked_at", str(int(datetime.datetime.fromisoformat(x["checked_at"].replace("Z", "+00:00")).timestamp()))], ["u", x["url"]], ["L", NS]]
    if x["key"].get("gtin"): tags.append(["l", "gtin:" + x["key"]["gtin"], NS])
    if x.get("stock"): tags.append(["l", "stock:" + x["stock"], NS])
    if x.get("cond"): tags.append(["l", "cond:" + x["cond"], NS])
    drafts.append({"kind": KIND_OFFER, "tags": tags, "content": json.dumps(compact(x), separators=(",", ":")), "_unsigned": True})
# ---- D5 policies / D7 trust / D11 ucp ----
pol = {}
AUD = {a["domain"]: a.get("fields") or {} for a in load(O("policies_audit.jsonl"))}
for f in ["policies.jsonl", "policies.r2.jsonl", "v4new/policies.jsonl"] + [os.path.relpath(g, O()) for g in sorted(glob.glob(O("policies.pw.*.jsonl")))]:
    for p in load(O(f)):
        if any(p.get(k) is not None for k in ("return_days", "price_match", "return_ship_payer", "restocking_pct")) or p["domain"] not in pol: pol[p["domain"]] = p
trust = {t["domain"]: t for t in load(O("trust.jsonl"))}
for d, r in recs.items():
    p = pol.get(d)
    if p and r.get("status") == "crawled" and any(p.get(k) is not None for k in ("return_days", "price_match", "return_ship_payer", "restocking_pct", "exclusions")):
        for fk, av in AUD.get(d, {}).items():   # sonnet audit disagreed with the extracted value: drop the field (unknown, not guessed)
            if av.get("ok") is False and fk in p: p.pop(fk, None); (p.get("quotes") or {}).pop(fk, None)
        r["policies"] = {k: p[k] for k in ("return_days", "return_ship_payer", "price_match", "price_match_window_days", "restocking_pct", "exclusions", "return_restrictions", "conflicting_sources", "quotes", "field_src", "checked_at", "method") if p.get(k) is not None}
        note(d, "policies: " + ", ".join(k for k in ("return_days", "return_ship_payer", "price_match", "restocking_pct") if p.get(k) is not None))
    t = trust.get(d)
    if t and t.get("created"): r["trust"] = {"created": t["created"], "age_bucket": t["age_bucket"], "src": t["src"], "checked_at": t["checked_at"], "method": "api"}
    s = seeds.get(d)
    if s and s.get("ucp") is not None:
        ep = None
        for sv in ((s.get("ucp_doc") or {}).get("ucp") or {}).get("services", {}).get("dev.ucp.shopping", []) or []:
            if sv.get("transport") == "mcp": ep = sv.get("endpoint")
        r["ucp"] = {"present": bool(s["ucp"]), "endpoint": ep, "src": f"https://{d}/.well-known/ucp", "checked_at": s["checked_at"], "method": "ucp"}
        if s.get("seed_source") and not r.get("seed_source"): r["seed_source"] = s["seed_source"]
# ---- D6 merchant-published promos (store's own pages only) ----
for pr in load(O("promos.raw.jsonl")):
    r = recs.get(pr["domain"])
    if r and pr.get("promos") and r.get("status") == "crawled":
        r["promos"] = [{k: x.get(k) for k in ("code", "desc", "min_spend", "expires", "stacking", "quote", "src", "checked_at") if x.get(k) is not None} for x in pr["promos"][:5]]
        note(pr["domain"], f"promos: {len(r['promos'])}")
# ---- round-1 item 9: grade the ungraded crypto-hardware stores from store-owned pages (robots-checked, honest UA; out/runs/btcev2-2026-10-30.json) ----
_EV = {x["url"]: x for x in json.load(open(O("runs", "btcev2-2026-10-30.json"))) if x.get("status") == 200} if os.path.exists(O("runs", "btcev2-2026-10-30.json")) else {}
def _evq(url, i=0):
    x = _EV.get(url); v = [h for h in (x or {}).get("hits", {}).values() if h]
    return (v[i] if len(v) > i else None), (x or {}).get("fetched_at")
CH = {
    "shop.trezor.io": ("https://trezor.io/faqs", ["btc"]),
    "foundation.xyz": ("https://docs.foundation.xyz/faq/home/", ["btc", "card"]),
    "bitkey.world": ("https://bitkey.world/learning-hub/bitkey-privacy", ["btc"]),
}
import btc_grade as _bg
for d, (url, codes) in CH.items():
    r = recs.get(d); q, at = _evq(url)
    if not r or not q: continue
    for c in codes:
        if not any(x["c"] == c and x.get("url") == url for x in r.get("pay_q") or []):
            r.setdefault("pay_q", []).append({"c": c, "neg": False, "url": url, "q": q, "conf": "high", "scope": "online", "checked_at": at})
        if c not in (r.get("pay") or []): r["pay"] = sorted(set(r.get("pay") or []) | {c}); note(d, f"pay +{c} (store page: {url})")
    g, info = _bg.grade_record(r, {"privacy": ["noacct"]} if r.get("guest") is True else None)
    if d == "foundation.xyz" and g is None:
        info = {"quote": q, "url": url, "range": "2-4", "basis": "claimed", "reason": "self-hosted BTCPay Server per the store's FAQ; whether checkout needs an account is not evidenced, so no single grade"}
    if d == "bitkey.world" and g is None:
        info = {"quote": q, "url": url, "range": "2-4", "basis": "claimed", "reason": "pays in bitcoin with only an email and pickup name per the store; the bitcoin processor (self-hosted or custodial) is not stated"}
    r["btc"] = g; r["btc_src"] = "agent-evidence" if g is not None else None
    r["btc_grade_quote"], r["btc_grade_url"], r["btc_grade_reason"] = info.get("quote"), info.get("url"), info.get("reason")
    r["btc_grade_basis"] = info.get("basis")   # grade and basis published together
    if info.get("range"): r["btc_grade_range"] = info["range"]
    r["btc_ev"] = {"url": info.get("url"), "q": info.get("quote"), "reason": info.get("reason"), "checked_at": at}
    note(d, f"btc graded: {g if g is not None else 'range ' + info.get('range', '?')} ({info.get('reason')})")
for d, why in {"shop.ledger.com": "support page lists Crypto.com Pay and 'Pay With Crypto' but the rendered text does not name bitcoin; not graded",
               "coinkite.com": "bitcoin payment terms live on store.coinkite.com, whose terms ban automated access; not graded"}.items():
    if d in recs and recs[d].get("btc") is None:
        recs[d]["btc_grade_reason"] = why; recs[d]["btc_grade_range"] = "0-4"; note(d, "btc: " + why)
# ---- round-1 item 5: a pay code needs a quote that actually says the store takes it ----
from pay_quote_check import supports as _pq_ok
_pq_audit = []
for d, r in recs.items():
    qs = r.get("pay_q") or []
    if not qs or r.get("status") != "crawled": continue
    ok_codes = set()
    for q in qs:
        if q.get("neg"): continue
        q["ok"] = _pq_ok(q["c"], q.get("q") or "")
        if q["ok"]: ok_codes.add(q["c"])
        else: _pq_audit.append({"d": d, "c": q["c"], "url": q.get("url"), "q": (q.get("q") or "")[:200], "verdict": "quote does not show the store accepts this method"})
    quoted = {q["c"] for q in qs if not q.get("neg")}
    drop = sorted(c for c in (r.get("pay") or []) if c in quoted and c not in ok_codes)
    if drop:
        for k in ("pay", "pay_online", "pay_instore", "pay_unscoped"):
            if isinstance(r.get(k), list): r[k] = [c for c in r[k] if c not in drop]
        r["pay_dropped"] = [{"c": c, "why": "only evidence was a quote that does not say the store accepts it (e.g. a product name or a refund note)", "checked_at": ISO(NOW)} for c in drop]
        note(d, f"pay dropped (unsupported quotes): {','.join(drop)}")
with open(O("pay-quote-audit-2026-10-30.jsonl"), "w") as f:
    for x in _pq_audit: f.write(json.dumps(x) + "\n")
# ---- Blair r1: indirect bitcoin routes (BitPay & similar processors, gift cards bought with BTC elsewhere) are not native BTC ----
INDIRECT = [(re.compile(r"(?i)\bbitpay\b"), "bitpay"), (re.compile(r"(?i)coinbase commerce"), "coinbase-commerce"), (re.compile(r"(?i)crypto\.com pay"), "crypto.com-pay"),
            (re.compile(r"(?i)gift ?cards? (from|at|via|on) (bitrefill|coincards|cryptorefills)|(bitrefill|coincards|cryptorefills)\W+(\w+\W+){0,4}gift ?cards?"), "gift-card-reseller")]
for d, r in recs.items():
    qs = [q for q in r.get("pay_q") or [] if q["c"] in ("btc", "ln") and not q.get("neg") and q.get("ok") is not False]
    if not qs: continue
    ind = []
    for q in qs:
        via = next((v for rx, v in INDIRECT if rx.search(q.get("q") or "")), None)
        if via and not (via == "gift-card-reseller" and d.split(".")[-2] in ("bitrefill", "coincards", "cryptorefills")): ind.append((q, via))
    if ind and len(ind) == len(qs):
        r["btc_indirect"] = [{"via": v, "code": q["c"], "q": q["q"][:200], "url": q.get("url"), "checked_at": q.get("checked_at") or ISO(r.get("ts") or NOW)} for q, v in ind]
        for k in ("pay", "pay_online", "pay_instore", "pay_unscoped"):
            if isinstance(r.get(k), list): r[k] = [c for c in r[k] if c not in ("btc", "ln")]
        for q in qs: q["ok"] = False
        note(d, "btc/ln -> btc_indirect (" + ",".join(sorted({v for _, v in ind})) + ")")
# ---- D4 agent-usable rails (deterministic: store's own pay quotes + UCP payment handlers) ----
RAIL = {"ln": "lightning", "lnurl": "lightning", "btc": "btc-onchain", "spay": "shop-pay", "pp": "paypal", "gift": "gift-card", "cashu": "cashu", "apay": "apple-pay", "gpay": "google-pay", "card": "card"}
for d, r in recs.items():
    if r.get("status") != "crawled": continue
    rails = []
    for q in r.get("pay_q") or []:
        rail = RAIL.get(q["c"])
        if not rail or q.get("neg") or q.get("ok") is False or any(x["rail"] == rail for x in rails): continue
        guest_ok = True if r.get("guest") is True and r.get("guest_src") in ("checkout-probe", "help-page") else None
        rails.append({"rail": rail, "scope": "online-checkout" if q.get("scope") == "online" else "pay-page", "guest_ok": guest_ok, "src": q["url"], "quote": q["q"][:200], "checked_at": ISO(r.get("ts") or NOW)})
    u = r.get("ucp") or {}
    if u.get("present"):
        rails.append({"rail": "ucp", "scope": "protocol", "guest_ok": None, "src": u["src"], "method": "ucp", "checked_at": u["checked_at"]})
    if rails: r["agentpay"] = rails
# ---- BTC grade 0 where the store's own payment list is complete and names no bitcoin (re-review item 6) ----
PAYLIST = re.compile(r"(?i)(we accept|accepted (forms of )?payment|payment (methods|options|types)|ways to pay|accepts these payment)")
for d, r in recs.items():
    if r.get("status") != "crawled" or r.get("btc") is not None or r.get("btc_any"): continue
    qs = [q for q in r.get("pay_q") or [] if not q.get("neg")]
    byurl = {}
    for q in qs: byurl.setdefault(q["url"], []).append(q)
    best = max(byurl.items(), key=lambda kv: len({q["c"] for q in kv[1]}), default=(None, []))
    if best[0] and len({q["c"] for q in best[1]}) >= 3 and any(PAYLIST.search(q["q"]) for q in best[1]):
        r["btc"] = 0; r["btc_conf"] = "low"; r["btc_ev"] = {"url": best[0], "q": next(q["q"] for q in best[1] if PAYLIST.search(q["q"]))[:200], "reason": f"store's payment-methods page lists {len({q['c'] for q in best[1]})} methods and no bitcoin"}
        note(d, "btc null -> 0 (payment list without bitcoin)")
    elif (r.get("checkout_probe") or {}).get("step_reached") == "payment_methods":
        r["btc"] = 0; r["btc_conf"] = "med"; r["btc_ev"] = {"url": None, "q": "payment screen reached; no bitcoin option shown", "reason": "agent-evidence"}; note(d, "btc null -> 0 (payment screen without bitcoin)")
for d, r in recs.items():
    if str(r.get("seed_source") or "").startswith("btcmap:"): r["seed_license"] = "ODbL-1.0"; r["seed_attribution"] = "BTC Map (btcmap.org), data (c) OpenStreetMap contributors, ODbL 1.0"
# ---- D9 per-field checked_at ----
for d, r in recs.items():
    fc = {"status": ISO(r.get("ts") or NOW), "tos": ISO(r.get("ts") or NOW)}
    if r.get("pay"): fc["pay"] = ISO(r.get("ts") or NOW) if r.get("pay_src") not in ("store-help-page-2026-10-30", "store-terms-of-sale-us") else ISO(NOW)
    if r.get("checkout_map"): fc["checkout"] = r["checkout_map"]["checked_at"]
    if r.get("guest") is not None: fc["guest"] = ISO((r.get("checkout_probe") or {}).get("ts") or r.get("ts") or NOW)
    if r.get("ship"): fc["ship"] = ISO(NOW) if d in ("sonos.com", "walmart.com") else ISO(r.get("ts") or NOW)
    if r.get("policies"): fc["policies"] = r["policies"]["checked_at"]
    if r.get("trust"): fc["trust"] = r["trust"]["checked_at"]
    if r.get("promos"): fc["promos"] = r["promos"][0]["checked_at"]
    if r.get("ucp"): fc["ucp"] = r["ucp"]["checked_at"]
    if r.get("btc") is not None: fc["btc"] = ISO(NOW) if r.get("btc_ev") else ISO(r.get("ts") or NOW)
    if r.get("why"): fc["why"] = ISO((r["why"] or {}).get("checked") or r.get("ts") or NOW)
    r["fields_checked"] = fc
# ---- write ----
changed = []
for d, r in recs.items():
    if d in added or json.dumps(r, sort_keys=True) != base_v3.get(d):
        r["v"] = V; changed.append(d)
with open(O("records.v4.jsonl"), "w") as f:
    for r in recs.values(): f.write(json.dumps(r, separators=(",", ":")) + "\n")
with open(O("offers.jsonl"), "w") as f:
    for x in offers: f.write(json.dumps(x) + "\n")
with open(O("offers.compact.ndjson"), "w") as f:
    for x in offers: f.write(json.dumps(compact(x), separators=(",", ":")) + "\n")
with open(O("offers.events.draft.jsonl"), "w") as f:
    for e in drafts: f.write(json.dumps(e) + "\n")
with open(O("v4-diff-2026-10-30.md"), "w") as f:
    f.write(f"# v0.5 record changes (built {ISO(NOW)})\n\nrecords: {len(recs)} ({len(added)} new), changed: {len(changed)}, offers: {len(offers)} from {len({x['domain'] for x in offers})} stores\n\n")
    f.write("## New index entries\n" + "".join(f"- {d} ({recs[d].get('status')}, seed {recs[d].get('seed_source')})\n" for d in added) + "\n## Notable changes\n")
    for d, ns in sorted(diff.items()): f.write(f"- **{d}**: " + "; ".join(ns) + "\n")
print(f"records {len(recs)} new {len(added)} changed {len(changed)} offers {len(offers)} stores_with_offers {len({x['domain'] for x in offers})} drafts {len(drafts)}")
import ledger_commit; ledger_commit.flush_and_commit()   # one ledger commit per pass (gated on KM_LEDGER_AUTOCOMMIT=1)
