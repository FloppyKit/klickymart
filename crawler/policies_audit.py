"""GO D5 audit: claude-sonnet-5.5 re-reads each extracted field against its verbatim quote and says whether the value follows.
Audits every row with values (well above the 10% sample). Output: out/policies_audit.jsonl"""
import json, glob, sys
import llm
rows = {}
for f in ["out/policies.jsonl", "out/policies.r2.jsonl"] + sorted(glob.glob("out/policies.pw.*.jsonl")):
    for l in open(f):
        p = json.loads(l)
        if p.get("quotes"): rows[p["domain"]] = p
out = open("out/policies_audit.jsonl", "w"); bad = tot = 0
for d, p in rows.items():
    items = {k: {"value": p.get(k if k != "exclusions" else "exclusions"), "quote": q} for k, q in p["quotes"].items()}
    prompt = ("For each field, decide if the extracted value is correctly supported by the quote from the store's policy page. "
              "Reply JSON {\"fields\":{\"<field>\":{\"ok\":true|false,\"fix\":<corrected value or null>}}}.\nStore: " + d + "\n" + json.dumps(items))
    try:
        raw = llm.chat("D5-audit", "anthropic/claude-sonnet-5.5", [{"role": "user", "content": prompt}], max_tokens=800)
        j = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
    except llm.CapReached: break
    except Exception as e: j = {"error": str(e)[:100]}
    for k, v in (j.get("fields") or {}).items():
        tot += 1; bad += 0 if v.get("ok") else 1
    out.write(json.dumps({"domain": d, **j}) + "\n")
print(f"audited fields {tot}, flagged {bad}, agreement {1 - bad / max(tot, 1):.1%}")
