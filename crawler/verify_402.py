#!/usr/bin/env python3
"""Agent-native 402 verification (2026-10-30). One honest unauthenticated GET per L402/x402 endpoint, through gate.py's
rules: stored terms verdict for the candidate domain must be "ok" (the gate only allows non-home paths once terms are ok),
then robots.txt of the endpoint host (error/403 => disallow). Never pays, never signs a payment, no accounts.
Writes out/verify-402.agent-native.json."""
import base64, json, os, re, sys, time, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import gate
from ua import UA
O = lambda *p: os.path.join(HERE, "out", *p)

def b64json(s):
    try: return json.loads(base64.b64decode(s + "=" * (-len(s) % 4)).decode())
    except Exception: return None

def bolt11_amount(inv):
    m = re.match(r"(?i)ln(?:bc|tb|bcrt)(\d+)([munp]?)1", inv or "")
    if not m: return None
    n, u = int(m.group(1)), m.group(2)
    btc = n * {"": 1, "m": 1e-3, "u": 1e-6, "n": 1e-9, "p": 1e-12}[u]
    return round(btc * 1e8, 3)  # sats

CAP = 4096  # max chars stored for any raw challenge string
_cap = lambda v: v[:CAP] if isinstance(v, str) else v

def l402_challenge(wa):
    """Parse an L402/LSAT WWW-Authenticate value into {scheme, macaroon, invoice, params, raw}. Store only; never pays."""
    m = re.search(r'(?i)\b(L402|LSAT)\b\s*(.*)', wa or "")
    if not m: return None
    params = {k.lower(): (q if q else u) for k, q, u in re.findall(r'([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^",\s]+))', m.group(2))}
    if not params.get("invoice") or not params.get("macaroon"): return None
    inv = params.pop("invoice").strip(); mac = params.pop("macaroon").strip()
    return {"scheme": m.group(1).upper(), "invoice": _cap(inv), "macaroon": _cap(mac), "macaroon_len": len(mac),
            "params": {k: _cap(v) for k, v in params.items()}, "raw": _cap(wa), "truncated": len(wa) > CAP or len(inv) > CAP or len(mac) > CAP}

def body_invoice(j):
    """Find a bolt11 in a 402 JSON body (invoice / payment_request / paymentRequest / pr, top level or one level down)."""
    keys = ("invoice", "payment_request", "paymentRequest", "pr", "bolt11")
    for d in [j] + [v for v in (j.values() if isinstance(j, dict) else []) if isinstance(v, dict)]:
        if not isinstance(d, dict): continue
        for k in keys:
            v = d.get(k)
            if isinstance(v, str) and re.match(r"(?i)ln(bc|tb|bcrt)", v.strip()): return k, v.strip()
    return None

def parse(code, hdrs, body):
    out = {"http": code}
    if code != 402: return out
    wa = hdrs.get("WWW-Authenticate") or ""
    c = l402_challenge(wa)
    if c:
        sats = bolt11_amount(c["invoice"])
        out.update(proto="l402", challenge="WWW-Authenticate " + c["scheme"], l402=c, price_seen={"amount": sats, "asset": "BTC-sats (LN invoice)"})
        return out
    reqs = None; j = None
    pr = hdrs.get("PAYMENT-REQUIRED") or hdrs.get("X-PAYMENT-REQUIRED")
    if pr: j = b64json(pr) or None; out["challenge"] = "PAYMENT-REQUIRED header"
    if j is None:
        try: j = json.loads(body); out["challenge"] = "402 JSON body"
        except Exception: j = None
    bi = body_invoice(j) if isinstance(j, dict) else None
    if bi:
        out.update(proto="l402", challenge="402 JSON body " + bi[0], price_seen={"amount": bolt11_amount(bi[1]), "asset": "BTC-sats (LN invoice)"},
                   l402={"scheme": "json-body", "field": bi[0], "invoice": _cap(bi[1]), "macaroon": _cap(j.get("macaroon")) if isinstance(j.get("macaroon"), str) else None,
                         "raw": _cap(body if isinstance(body, str) else json.dumps(j)), "truncated": len(bi[1]) > CAP})
        return out
    if isinstance(j, dict) and isinstance(j.get("accepts"), list) and j["accepts"]:
        a = j["accepts"][0]
        amt = a.get("maxAmountRequired") or a.get("amount") or a.get("price")
        out.update(proto="x402", x402Version=j.get("x402Version"), price_seen={
            "amount": amt, "asset": a.get("asset"), "network": a.get("network"), "scheme": a.get("scheme"),
            "extra": (a.get("extra") or {}).get("name"), "n_accepts": len(j["accepts"])})
    return out

def main():
    prev = {x["d"]: x for x in json.load(open(O("verify-402.agent-native.json")))} if os.path.exists(O("verify-402.agent-native.json")) else {}
    found = json.load(open(O("l402-endpoints.chosen.json"))) if os.path.exists(O("l402-endpoints.chosen.json")) else {}
    res = []
    for l in open(O("records.agent-native.jsonl")):
        r = json.loads(l)
        if r.get("an_cat") not in ("l402", "x402"): continue
        ep = (r.get("agent_api") or {}).get("endpoint") or (found.get(r["d"]) or {}).get("endpoint")
        if r["d"] in prev and prev[r["d"]].get("result") in ("verified-402", "no-402", "unreachable"):
            res.append(prev[r["d"]]); continue  # one request per endpoint, ever
        row = {"d": r["d"], "cat": r["an_cat"], "endpoint": ep}
        if r.get("status") != "crawled": row.update(result="not-probed", why=f"status={r.get('status')}"); res.append(row); continue
        if not ep: row.update(result="not-probed", why="no endpoint in data"); res.append(row); continue
        v = gate.verdict(r["d"]) or {}
        tos = r.get("tos") or v.get("tos")
        if tos != "ok": row.update(result="not-probed", why=f"gate: no ok terms verdict (tos={tos})"); res.append(row); continue
        if not gate._robots_ok(ep): row.update(result="not-probed", why="gate: robots.txt disallows or errored"); res.append(row); continue
        gate._bypass.on = True  # gate checks done above for the registrable domain + endpoint host robots
        try:
            req = urllib.request.Request(ep, headers={"User-Agent": UA, "Accept": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=25) as resp: code, h, body = resp.status, resp.headers, resp.read(200000)
            except urllib.error.HTTPError as e: code, h, body = e.code, e.headers, e.read(200000)
            p = parse(code, h, body.decode("utf-8", "replace"))
            row.update(p, result="verified-402" if p.get("proto") in ("l402", "x402") else "no-402")
        except Exception as e:
            row.update(result="unreachable", err=type(e).__name__ + ": " + str(e)[:160])
        finally: gate._bypass.on = False
        row["ts"] = int(time.time()); res.append(row); time.sleep(1)
    json.dump(res, open(O("verify-402.agent-native.json"), "w"), indent=1)
    for x in res: print(x["d"], x["result"], x.get("http", ""), x.get("price_seen", ""), x.get("why", ""))

if __name__ == "__main__": main()
