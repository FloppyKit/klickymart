"""M4 S5: deterministic shipping-policy parser (no model, no paid service). Turns a store's public shipping-policy page
text (Shopify /policies/shipping-policy) and product-page JSON-LD shippingDetails into ShipRule objects for
site/worker/src/landed.ts (`policyShip`). Every rule carries the verbatim sentence it came from. Anything not matched
stays unknown: we never guess a price. Conditional rules (members, promo codes, first orders, ...) are tagged with
`conditions` so the Worker never applies them to a guest (same vocabulary as site/worker/src/ship-rules.ts).
Fetching (shipping_obs): robots.txt first via trust_obs.Polite (error/403 = disallow), honest UA, 2-minute timeouts,
the widen-gate allow-list, public pages only (no cart, checkout or login)."""
import json, re, hashlib, os, sys, argparse, datetime
from ship import ld_blocks, walk, text_of

USD = r"\$\s?(\d{1,4}(?:[.,]\d{2})?)"
CONDITIONAL = re.compile(r"\b(members?|membership|loyalty|rewards? (program|members?)|subscribers?|subscription|prime|club|insiders?|vip|promo(tion(al)?)? codes?|coupon|discount code|use code|first[- ]time|first order|students?|military|account holders?|signed[- ]in|logged[- ]in|when you sign (in|up)|limited[- ]time|for a limited time)\b", re.I)
INTL = re.compile(r"\b(international|outside (the )?(us|u\.s\.|united states)|canada|worldwide|overseas)\b", re.I)
AKHI = re.compile(r"\b(alaska|hawaii|ak\b|hi\b|puerto rico|apo|fpo)\b", re.I)
CONTIG = re.compile(r"\b(contiguous|lower 48|continental (us|u\.s\.|united states))\b", re.I)

PATTERNS = [  # (type, regex); order matters: the first match in a sentence wins
    ("calculated", re.compile(r"\b(calculated|determined|shown|displayed|charged) (at|during|in) (the )?checkout\b|\bcalculated based on\b|\bat checkout based on\b", re.I)),
    ("free_over", re.compile(r"\bfree\b[^.]{0,40}\bshipping\b[^.]{0,40}\b(orders?|purchases?)\b[^.]{0,20}\b(over|above|of|exceeding|totaling|at least)\b[^$.]{0,12}" + USD, re.I)),
    ("free_over", re.compile(r"\b(orders?|purchases?)\b[^.]{0,20}\b(over|above|of|exceeding|at least)\b\s*" + USD + r"\+?[^.]{0,40}\b(ship|qualify for|receive|get|are eligible for)\b[^.]{0,20}\bfree\b", re.I)),
    ("free_over", re.compile(r"\bfree\b[^.]{0,30}\bshipping\b[^.]{0,10}\b(over|above)\b\s*" + USD, re.I)),
    ("free", re.compile(r"\b(shipping is (always )?free|free (standard |ground )?shipping on (all|every)\b|all orders ship free|we (offer|provide) free shipping on (all|every)\b|always free shipping)\b", re.I)),
    ("flat", re.compile(r"\bflat[- ]rate\b[^.$]{0,30}" + USD + r"|" + USD + r"\s*flat[- ]rate\b|\b(standard|ground|domestic|regular) shipping (is|costs|of|rate is|:)\s*(a flat )?" + USD + r"|\bwe charge (a flat )?" + USD + r"\b[^.]{0,20}\bshipping\b|\bshipping (is|costs) (a flat )?" + USD + r"|\bship\w* to\b[^.$]{0,40}\b(is|costs|are)\b\s*(a flat )?" + USD + r"|\b(ship|shipping)\b[^.$]{0,20}\bfor (a flat (rate of )?)?" + USD, re.I)),
]

def sentences(text):
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+|\s•\s", text) if s.strip()]

def _usd(m):
    for g in reversed(m.groups()):
        if g and re.fullmatch(r"\d{1,4}(?:[.,]\d{2})?", g): return float(g.replace(",", "."))
    return None

def region_of(s):
    if AKHI.search(s) and not CONTIG.search(s): return "AK-HI"
    if CONTIG.search(s): return "contiguous-US"
    return "US"

def parse_text(text):
    """-> (rules, ships_us). rules: [{type, usd?, min_usd?, region, quote, conditions}]; unmatched text yields nothing."""
    rules, seen = [], set()
    ships_us = None
    for s in sentences(text):
        if INTL.search(s) and not re.search(r"\b(us|u\.s\.|united states|domestic|contiguous|lower 48)\b", s, re.I): continue  # international-only sentence
        if re.search(r"\b(ship|deliver)\w* (to|within|across) (all 50 states|the (us|u\.s\.|united states))\b", s, re.I): ships_us = True
        if re.search(r"\b(do not|don't|cannot|can't|only) ship\b[^.]{0,30}\b(us|u\.s\.|united states)\b", s, re.I) and re.search(r"\b(do not|don't|cannot|can't)\b", s, re.I): ships_us = False
        for typ, rx in PATTERNS:
            m = rx.search(s)
            if not m: continue
            r = {"type": typ, "region": region_of(s), "quote": s[:300]}
            if typ == "free_over": r["min_usd"] = _usd(m)
            if typ == "flat":
                r["usd"] = _usd(m)
                if r["region"] != "US": r["type"] = "per_region"
            if typ in ("free_over", "flat") and (r.get("min_usd") if typ == "free_over" else r.get("usd")) is None: break
            c = CONDITIONAL.search(s); r["conditions"] = f'conditional: "{c.group(0)}"' if c else None
            k = (r["type"], r.get("usd"), r.get("min_usd"), r["region"], r["conditions"])
            if k not in seen: seen.add(k); rules.append(r)
            break
    return rules, ships_us

def rules_from_ld(html):
    """JSON-LD OfferShippingDetails with a US (or unspecified) destination and a USD rate -> flat / free_over rules."""
    out = []
    for b in ld_blocks(html):
        for o in walk(b):
            if not (o.get("@type") == "OfferShippingDetails" or "shippingRate" in o): continue
            rate = o.get("shippingRate") or {}; rate = rate[0] if isinstance(rate, list) and rate else rate
            dest = o.get("shippingDestination") or {}; dest = dest[0] if isinstance(dest, list) and dest else dest
            country = dest.get("addressCountry") if isinstance(dest, dict) else None
            if country not in (None, "US", "USA"): continue
            q = json.dumps({"shippingRate": rate, "shippingDestination": dest}, sort_keys=True)[:300]
            try: v = float(rate.get("value")) if isinstance(rate, dict) and rate.get("value") is not None else None
            except Exception: v = None
            cur = rate.get("currency") if isinstance(rate, dict) else None
            if v is not None and cur == "USD": out.append({"type": "free" if v == 0 else "flat", **({} if v == 0 else {"usd": v}), "region": "US", "quote": q, "conditions": None, "method": "jsonld-shippingDetails"})
            ft = o.get("freeShippingThreshold")
            if isinstance(ft, dict) and ft.get("priceCurrency", "USD") == "USD":
                try: out.append({"type": "free_over", "min_usd": float(ft.get("price")), "region": "US", "quote": json.dumps(ft, sort_keys=True)[:300], "conditions": None, "method": "jsonld-shippingDetails"})
                except Exception: pass
    return out

# ---- fetch + observation rows (ship_policy_obs, append-only) ----
def policy_obs(domain, rules, ships_us, src, at):
    body = json.dumps({"rules": rules, "ships_us": ships_us}, sort_keys=True, separators=(",", ":"))
    return {"id": hashlib.sha256(f"{domain}\0{body}".encode()).hexdigest(), "domain": domain, "rules_json": json.dumps(rules, sort_keys=True, separators=(",", ":")),
            "ships_us": None if ships_us is None else int(ships_us), "src": src, "checked_at": at}

def shipping_obs(pol, domain, at, product_url=None):
    """One store: its public shipping-policy page, plus optional product-page JSON-LD. None rules list = unknown."""
    url = f"https://{domain}/policies/shipping-policy"
    st, body = pol.get(url)
    rules, ships_us = parse_text(text_of(body)) if st == 200 else ([], None)
    if product_url:
        st2, body2 = pol.get(product_url)
        if st2 == 200: rules += rules_from_ld(body2)
    return policy_obs(domain, rules, ships_us, url if st == 200 else None, at)

def sql_for(rows):
    esc = lambda v: "NULL" if v is None else str(v) if isinstance(v, int) else "'" + str(v).replace("'", "''") + "'"
    return "".join(f"INSERT OR IGNORE INTO ship_policy_obs (id, domain, rules_json, ships_us, src, checked_at) VALUES ({', '.join(esc(r[k]) for k in ('id','domain','rules_json','ships_us','src','checked_at'))});\n" for r in rows)

def main(argv=None):
    from trust_obs import Polite, now_s
    from widen_gate import norm, link_only
    ap = argparse.ArgumentParser(description="M4 S5 shipping policies (live network; run only after the S1 widen gate passes)")
    ap.add_argument("--domains", required=True); ap.add_argument("--precrawl", required=True)
    ap.add_argument("--out-dir", default=os.path.join(os.path.dirname(__file__), "out"))
    a = ap.parse_args(argv)
    ok = {norm(json.loads(l).get("d", "")) for l in open(a.precrawl) if l.strip() and json.loads(l).get("decision") == "crawl"}
    pol, at, rows = Polite(), now_s(), []
    for d in (norm(l) for l in open(a.domains) if l.strip() and not l.startswith("#")):
        if d in ok and not link_only(d): rows.append(shipping_obs(pol, d, at))
    os.makedirs(a.out_dir, exist_ok=True); day = datetime.date.today().strftime("%Y%m%d")
    with open(os.path.join(a.out_dir, f"ship-policy-obs-{day}.jsonl"), "w") as f: f.writelines(json.dumps(r) + "\n" for r in rows)
    with open(os.path.join(a.out_dir, f"ship-policy-obs-{day}.sql"), "w") as f: f.write(sql_for(rows))
    print(f"ship: {len(rows)} stores, {sum(1 for r in rows if r['rules_json'] != '[]')} with at least one rule")
    return 0

if __name__ == "__main__":
    sys.exit(main())
