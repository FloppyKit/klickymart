#!/usr/bin/env python3
"""GO 3.2 QA: schema/null audit, every pay item quoted, counts. Writes out/QA-REPORT.md and ../QA-BTC-GRADE.csv."""
import json, csv, collections, time, sys, os
REC = sys.argv[1] if len(sys.argv) > 1 else "out/records.jsonl"
recs = [json.loads(l) for l in open(REC) if l.strip()]
probes = {}
if os.path.exists("out/checkout.jsonl"):
    for l in open("out/checkout.jsonl"):
        if l.strip(): x = json.loads(l); probes[x["d"]] = x
sites = [s["d"] for s in json.load(open("sites.250.json"))]
tos = {json.loads(l)["d"]: json.loads(l) for l in open("out/tos.jsonl") if l.strip()}
byd = {r["d"]: r for r in recs}
BTC = {"btc","ln","liq","cashu","fedi","ark","sp","bolt12","lnurl"}
REQ = {"crawled": ["d","cat","v","ts","ua","vantage","status","ar","fetch","ag","pay","pay_no","pay_q","pay_online","pay_instore","pay_unscoped","evu","btc","btc_any","tos","name","name_src","name_ev"],
       "agents-not-welcome": ["d","status","anw","fetch","vantage","ar"], "error": ["d","status","anw","fetch"],
       "blocked-tos": ["d","status","tos","tos_q","tos_url","vantage"]}
errs = []; unquoted = []
for r in recs:
    st = r.get("status") or ("error" if r.get("err") else "?")
    for k in REQ.get(st, ["status"]):
        if k not in r: errs.append(f"{r['d']}: missing `{k}` (status {st})")
    for p in r.get("pay", []):
        if not any(q["c"] == p and not q["neg"] and q.get("q") and q.get("url") for q in r.get("pay_q", [])): unquoted.append(f"{r['d']}:{p}")
    for q in r.get("pay_q", []):
        if "scope" not in q: errs.append(f"{r['d']}: pay_q item without scope")
missing = [d for d in sites if d not in byd]
st = collections.Counter(r.get("status") or ("error" if r.get("err") else "?") for r in recs)
anw = collections.Counter((r.get("anw") or {}).get("type") for r in recs if r.get("status") == "agents-not-welcome")
errt = collections.Counter((r.get("anw") or {}).get("type") or ("exception" if r.get("err") else "?") for r in recs if r.get("status") in ("error", None))
btc = collections.Counter(str(r.get("btc")) for r in recs if r.get("status") == "crawled")
crawled = [r for r in recs if r.get("status") == "crawled"]
nulls = {k: sum(1 for r in crawled if r.get(k) in (None, "", [])) for k in ("name","ag","tos","btc","co","pay","kyc")}
agc = collections.Counter(str(r.get("ag")) for r in crawled)
btc_any = [r for r in crawled if r.get("btc_any")]
arc = collections.Counter(a["c"] for r in recs for a in r.get("ar", []))
payc = collections.Counter(p for r in crawled for p in r.get("pay", []))
tosc = collections.Counter(str(t.get("tos")) for t in tos.values())
btc_pos = [r for r in recs if r.get("btc_any") or (r.get("btc") or 0) >= 1]
hostile = sorted(((r["d"], r.get("status"), (r.get("anw") or {}).get("type") or ",".join(sorted({a["c"] for a in r.get("ar", [])})),
                  (r.get("anw") or {}).get("q") or r.get("tos_q") or "") for r in recs if r.get("status") in ("agents-not-welcome", "blocked-tos")), key=lambda x: x[1])
stepc = collections.Counter(p["step_reached"] for p in probes.values())
def ev(r):
    qs = [f'{q["c"]}: "{q["q"][:90]}" ({q["url"]})' for q in r.get("pay_q", []) if q["c"] in BTC and not q["neg"]]
    p = probes.get(r["d"])
    if p: qs += [f'checkout {m["c"]}: "{m["ev"][:60]}"' for m in p.get("methods", []) if m["c"] in BTC]
    return "; ".join(qs[:3]) or "(btc_any without quote)"
L = [f"# QA report: full crawl ({time.strftime('%Y-%m-%d %H:%M %Z')})", "", f"Records file: `{REC}`.", "",
     f"Sites in list: {len(sites)}. Records: {len(recs)}. Sites without a record: {len(missing)} {missing[:10]}", "",
     "Vantage: one datacenter IP (see KNOWN-LIMITATIONS.md). Not representative of residential users.", "",
     "## Outcome", "| status | count |", "|---|---|"] + [f"| {k} | {v} |" for k, v in st.most_common()] + [
     "", "## Agents not welcome, by type", "| type | count |", "|---|---|"] + [f"| {k} | {v} |" for k, v in anw.most_common()] + [
     "", "## Errors, by type", "| type | count |", "|---|---|"] + [f"| {k} | {v} |" for k, v in errt.most_common()] + [
     "", "## ToS check (tos.py)", "| tos | count |", "|---|---|"] + [f"| {k} | {v} |" for k, v in tosc.most_common()] + [
     "", "## Crawled sites: agent access `ag`", "| ag | count |", "|---|---|"] + [f"| {k} | {v} |" for k, v in sorted(agc.items())] + [
     "", "## Bitcoin grade `btc` (crawled sites)", "| btc | count |", "|---|---|"] + [f"| {k} | {v} |" for k, v in sorted(btc.items())] + [
     "", f"`btc_any` true (some bitcoin option quoted): {len(btc_any)}. Grades 1-4 need processor/custody evidence (hand grading or a conclusive checkout probe, `btc_src`); QA-BTC-GRADE.csv lists every btc_any record.", "",
     "## Restrictions seen (`ar` codes, all records)", "| code | count |", "|---|---|"] + [f"| {k} | {v} |" for k, v in arc.most_common()] + [
     "", "## Payment methods quoted (crawled sites, top 25)", "| method | sites |", "|---|---|"] + [f"| {k} | {v} |" for k, v in payc.most_common(25)] + [
     "", f"## BTC-positive sites ({len(btc_pos)})", "| domain | status | btc grade | btc_priv | evidence |", "|---|---|---|---|---|"] + [
     f"| {r['d']} | {r.get('status')} | {r.get('btc')} | {','.join(r.get('btc_priv') or [])} | {ev(r).replace('|','/')} |" for r in btc_pos] + [
     "", f"## Guest checkout probe ({len(probes)} sites)", "| step reached | count |", "|---|---|"] + [f"| {k} | {v} |" for k, v in stepc.most_common()] + [
     "", "| domain | step | pm_visible | btc_offered | methods | note |", "|---|---|---|---|---|---|"] + [
     f"| {d} | {p['step_reached']} | {p['pm_visible']} | {p['btc_offered']} | {','.join(m['c'] for m in p['methods'])} | {(p.get('n') or '').splitlines()[0][:70] if p.get('n') else ''} |" for d, p in probes.items()] + [
     "", f"## Agent-hostile findings ({len(hostile)})", "| domain | status | type | quote |", "|---|---|---|---|"] + [
     f"| {d} | {st_} | {t} | {(q or '')[:100].replace('|','/')} |" for d, st_, t, q in hostile[:60]] + [
     "", "## Null audit (crawled sites)", "| field | null/empty |", "|---|---|"] + [f"| {k} | {v} of {len(crawled)} |" for k, v in nulls.items()] + [
     "", "## Schema checks", f"- schema errors: {len(errs)}"] + [f"  - {e}" for e in errs[:50]] + [
     f"- pay items without a quote: {len(unquoted)}"] + [f"  - {u}" for u in unquoted[:50]]
open("out/QA-REPORT.md", "w").write("\n".join(L) + "\n")
rows = []
for r in btc_any:
    for q in r["pay_q"]:
        if q["c"] in BTC:
            rows.append(dict(domain=r["d"], name=r.get("name"), btc_grade=r.get("btc"), btc_src=r.get("btc_src"), btc_priv=",".join(r.get("btc_priv") or []), checkout_step=(probes.get(r["d"]) or {}).get("step_reached"), method=q["c"], negated=q["neg"], scope=q.get("scope"), conf=q["conf"],
                             evidence_quote=q["q"], evidence_url=q["url"], qa_checked="", qa_correct_grade="", qa_reviewer="", qa_notes=""))
with open("../QA-BTC-GRADE.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["domain","name","btc_grade","btc_src","btc_priv","checkout_step","method","negated","scope","conf","evidence_quote","evidence_url","qa_checked","qa_correct_grade","qa_reviewer","qa_notes"]); w.writeheader(); w.writerows(rows)
M = ["# Bitcoin grade QA (generated by crawler/qa.py)", "", f"Source: `crawler/{REC}`. {len(btc_any)} crawled records with some bitcoin evidence; rows in QA-BTC-GRADE.csv: {len(rows)}.",
     "Fill `qa_checked`, `qa_correct_grade`, `qa_reviewer`, `qa_notes` by hand. Grades: see CRAWL-RUBRIC.md.", "",
     "| domain | grade | range | src | btc_priv | checkout probe | reason | quote | url |", "|---|---|---|---|---|---|---|---|---|"] + [
     f"| {r['d']} | {r.get('btc')} | {r.get('btc_grade_range') or ''} | {r.get('btc_src') or ''} | {','.join(r.get('btc_priv') or [])} | {(probes.get(r['d']) or {}).get('step_reached') or ''} | {r.get('btc_grade_reason') or ''} | {(r.get('btc_grade_quote') or '')[:140].replace('|','/')} | {r.get('btc_grade_url') or ''} |" for r in btc_any]
open("../QA-BTC-GRADE.md", "w").write("\n".join(M) + "\n")
print(open("out/QA-REPORT.md").read()[:2500])
