#!/usr/bin/env python3
"""Read-only UCP checkout quotes (Matt OK 2026-10-31): search_catalog -> create_checkout (ship-to = business address
from probe.local.json) -> read totals -> cancel_checkout. NEVER complete_checkout, never payment instruments.
The address is never written or printed: only totals and option titles leave this process. Gate (robots+terms) per URL.
Every checkout is journaled in an append-only ledger (UQ-1); --cleanup cancels ledger entries still open.
Usage: python ucp_quote.py d1 d2 ... [--out out/ucp-quotes-1031.json] | python ucp_quote.py --cleanup"""
import json, sys, time, os, uuid, unicodedata, urllib.request, urllib.error, argparse
from ua import UA
import gate
PROFILE = "https://klickymart.com/ucp/quote-profile.json"; PACE = 3.0
LEDGER = "out/ucp-ledger.jsonl"; MAX_BYTES = 1 << 20  # UQ-5: 1 MB cap
PII_KEYS = {"first_name", "last_name", "name", "full_name", "street_address", "extended_address", "address_locality",
            "address_region", "postal_code", "email", "phone", "phone_number", "address1", "address2", "line1", "line2",
            "city", "state", "zip", "province", "destinations", "buyer", "shipping_address", "billing_address"}
P = None; DEST = None; SECRET_NORM = []

def _norm(s):
    s = unicodedata.normalize("NFKD", str(s)); return "".join(c for c in s if not unicodedata.combining(c)).casefold()

def load_probe(path="probe.local.json"):
    """UQ-3: every probe value (name parts, line1/2, city, state, zip, email, phone) becomes a secret."""
    global P, DEST, SECRET_NORM
    with open(path) as f: P = json.load(f)
    A = P["address"]
    fn, _, ln = P["name"].partition(" ")
    vals = [P.get("name"), fn, ln, *P["name"].split(), P.get("email"), P.get("phone"), A.get("line1"), A.get("line2"),
            A.get("city"), A.get("state"), A.get("zip"), A.get("phone"), A.get("email")]
    SECRET_NORM = sorted({_norm(v) for v in vals if v and len(str(v).strip()) >= 2}, key=len, reverse=True)
    DEST = {"id": "d1", "first_name": fn, "last_name": ln or fn, "street_address": A["line1"], "extended_address": A.get("line2") or "",
            "address_locality": A["city"], "address_region": A["state"], "postal_code": A["zip"], "address_country": A.get("country") or "US"}

def _scrub_str(s):
    n = _norm(s)
    if not any(v in n for v in SECRET_NORM): return s
    # NFKD/casefold may change length; when any secret matches, redact on the normalized text
    for v in SECRET_NORM: n = n.replace(v, "[redacted]")
    return n

def scrub_obj(o):
    """Structural scrub of parsed data: drop PII keys, redact secret substrings case/accent-insensitively."""
    if isinstance(o, dict): return {k: ("[redacted]" if str(k).lower() in PII_KEYS else scrub_obj(v)) for k, v in o.items()}
    if isinstance(o, list): return [scrub_obj(x) for x in o]
    if isinstance(o, str): return _scrub_str(o)
    return o

def leaks(s): n = _norm(s); return [v for v in SECRET_NORM if v in n]
def scrub(s): return _scrub_str(str(s))

class _NoRedirect(urllib.request.HTTPRedirectHandler):  # UQ-4
    def redirect_request(self, *a, **k): return None
OPENER = urllib.request.build_opener(_NoRedirect)

def _read_capped(resp):
    data = resp.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES: raise RuntimeError("response exceeds 1 MB cap")
    return data

def http_post(u, body):
    """Returns (status, parsed_json). Any 3xx or non-2xx raises."""
    r = urllib.request.Request(u, data=body, headers={"User-Agent": UA, "content-type": "application/json", "accept": "application/json"})
    try: resp = OPENER.open(r, timeout=40)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}" + (" redirect refused" if 300 <= e.code < 400 else ""))
    st = getattr(resp, "status", None) or resp.getcode()
    if not 200 <= st < 300: raise RuntimeError(f"HTTP {st}")
    return st, json.loads(_read_capped(resp))

_id = 0
def call(d, name, args, with_status=False):
    global _id; _id += 1; u = f"https://{d}/api/ucp/mcp"; gate.check(u); time.sleep(PACE)
    args = {"meta": {"ucp-agent": {"profile": PROFILE}}, **args}
    body = json.dumps({"jsonrpc": "2.0", "id": _id, "method": "tools/call", "params": {"name": name, "arguments": args}}).encode()
    st, j = http_post(u, body)
    if not isinstance(j, dict): raise RuntimeError(f"{name}: non-object response")
    if "error" in j: raise RuntimeError(f"{name}: {json.dumps(scrub_obj(j['error']))[:200]}")
    res = j.get("result") or {}; sc = res.get("structuredContent")
    if sc is None:
        t = "".join(c.get("text", "") for c in res.get("content", []) if isinstance(c, dict))
        try: sc = json.loads(t)
        except Exception: sc = {"_text": t}
    if res.get("isError"): raise RuntimeError(f"{name}: {json.dumps(scrub_obj(sc))[:300]}")
    return (st, sc) if with_status else sc

# ---- UQ-1 ledger (append-only JSONL; latest event per key wins) ----
def ledger(ev, **kw):
    os.makedirs(os.path.dirname(LEDGER) or ".", exist_ok=True)
    with open(LEDGER, "a") as f:
        f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "ev": ev, **kw}) + "\n"); f.flush(); os.fsync(f.fileno())

def open_entries():
    st = {}
    if not os.path.exists(LEDGER): return []
    for line in open(LEDGER):
        try: e = json.loads(line)
        except Exception: continue
        k = e.get("key"); st.setdefault(k, {}).update({x: e[x] for x in ("d", "cid") if e.get(x)}); st[k]["ev"] = e["ev"]
    return [{"key": k, **v} for k, v in st.items() if v["ev"] != "cancelled"]

def _cid(co):
    if not isinstance(co, dict): return None
    c = co.get("checkout", co)
    return (c.get("id") or c.get("checkout_id") or co.get("id")) if isinstance(c, dict) else None

def cancel(d, cid, key):
    """UQ-2: cancelled only if 2xx and returned status says canceled/cancelled."""
    try:
        st, r = call(d, "cancel_checkout", {"id": cid}, with_status=True)
        s = str(((r.get("checkout", r) if isinstance(r, dict) else {}) or {}).get("status", "")).lower()
        if 200 <= st < 300 and s in ("canceled", "cancelled"):
            ledger("cancelled", key=key, d=d, cid=cid); return "cancelled", None
        ledger("cancel_unconfirmed", key=key, d=d, cid=cid, status=s[:40]); return "cancel_unconfirmed", f"status={s[:40]!r}"
    except Exception as e:
        ledger("cancel_unconfirmed", key=key, d=d, cid=cid); return "cancel_unconfirmed", scrub(str(e))[:200]

def money(x):
    if isinstance(x, dict) and "amount" in x: return x["amount"]
    return x
def totals(co):
    out = {}
    for t in co.get("totals") or []:
        out[t.get("type") or t.get("display_text")] = money(t.get("amount", t))
    return out
def first_variant(sc):
    for p in sc.get("products") or sc.get("results") or []:
        for v in p.get("variants") or []:
            if v.get("availability", {}).get("available", True) is not False:
                pr = v.get("price") or (v.get("price_range") or {}).get("min") or {}
                return p.get("title"), v["id"], money(pr)
    return None

def quote(d, q):
    if DEST is None: load_probe()
    sc = call(d, "search_catalog", {"catalog": {"query": q, "context": {"address_country": "US"}}})
    fv = first_variant(sc)
    if not fv: return {"d": d, "ok": False, "why": "no product from search_catalog", "keys": list(sc)[:8]}
    title, vid, price = fv
    key = uuid.uuid4().hex; cid = None
    rec = {"d": d, "ok": False, "product": title, "variant": vid, "list_price": price, "ship_options": [], "ledger_key": key}
    ledger("intent", key=key, d=d)  # before create
    try:
        co = call(d, "create_checkout", {"checkout": {"line_items": [{"item": {"id": vid}, "quantity": 1}],
                  "fulfillment": {"methods": [{"type": "shipping", "destinations": [DEST], "selected_destination_id": "d1"}]}}})
        cid = _cid(co)
        if cid: ledger("created", key=key, d=d, cid=cid)
        else:
            ledger("open_no_id", key=key, d=d); rec["why"] = "create_checkout returned no id; flagged in ledger"; return rec
        co = co.get("checkout", co)
        rec.update({"currency": co.get("currency"), "status": co.get("status"), "totals": totals(co)})
        for m in (co.get("fulfillment") or {}).get("methods") or []:
            for g in m.get("groups") or []:
                opts = [(o.get("id"), o.get("title"), money((o.get("totals") or [{}])[0].get("amount") if o.get("totals") else o.get("amount"))) for o in g.get("options") or []]
                rec["ship_options"] += [{"title": t, "amount": a} for _, t, a in opts]
                if opts and not g.get("selected_option_id"):
                    cheapest = min(opts, key=lambda o: o[2] if isinstance(o[2], (int, float)) else 1e12)
                    co2 = call(d, "update_checkout", {"id": cid, "checkout": {"line_items": [{"item": {"id": vid}, "quantity": 1}],
                               "fulfillment": {"methods": [{"type": "shipping", "destinations": [DEST], "selected_destination_id": "d1",
                               "groups": [{"id": g["id"], "selected_option_id": cheapest[0]}]}]}}})
                    co2 = co2.get("checkout", co2); rec["totals"] = totals(co2); rec["selected_ship"] = cheapest[1]; rec["status"] = co2.get("status")
        rec["ok"] = True
    except BaseException as e:
        rec["why"] = scrub(str(e))[:300] or type(e).__name__
        if not cid: ledger("open_unknown", key=key, d=d)  # create may have succeeded server-side
        if not isinstance(e, Exception): raise
    finally:
        if cid:
            rec["cancel"], err = cancel(d, cid, key)
            rec["cancelled"] = rec["cancel"] == "cancelled"
            if err: rec["cancel_err"] = err
    return rec

def cleanup():
    res = []
    for e in open_entries():
        if e.get("cid"): r, err = cancel(e["d"], e["cid"], e["key"]); res.append({"key": e["key"], "d": e["d"], "result": r, "err": err})
        else: res.append({"key": e["key"], "d": e.get("d"), "result": "needs_manual_review_no_id"})
    return res

def emit(obj):
    s = json.dumps(scrub_obj(obj), indent=1)
    if leaks(s): raise RuntimeError("PII scrub failed; refusing to emit")
    return s

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("domains", nargs="*"); ap.add_argument("--out", default="out/ucp-quotes-1031.json")
    ap.add_argument("--q", default="t-shirt"); ap.add_argument("--cleanup", action="store_true")
    a = ap.parse_args(); load_probe()
    if a.cleanup:
        for r in cleanup(): print(emit(r))
        sys.exit(0)
    out = {}
    try:
        for d in a.domains:
            try: r = quote(d, a.q)
            except Exception as e: r = {"d": d, "ok": False, "why": scrub(str(e))[:300]}
            r["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()); out[d] = r
            print(emit(r)[:2000])
    finally:
        open(a.out, "w").write(emit(out))
