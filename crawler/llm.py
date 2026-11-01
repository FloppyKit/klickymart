"""OpenRouter client with a hard cumulative spend cap for this round (Matt: $10). Ledger: out/runs/openrouter-cost-2026-10-30.log
(one JSON line per call: go, model, tokens, cost_usd from OpenRouter usage accounting). The key is read from env only, never logged."""
import json, os, time, threading, urllib.request, urllib.error
import gate; gate.install()  # every fetch goes through the gate
LEDGER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "runs", "openrouter-cost-2026-10-30.log")
CAP_USD = 9.50   # stop before the $10 round cap
_lock = threading.Lock()
class CapReached(Exception): pass
def spent(go=None):
    if not os.path.exists(LEDGER): return 0.0
    t = 0.0
    for l in open(LEDGER):
        r = json.loads(l)
        if go is None or r["go"] == go: t += r.get("cost_usd") or 0
    return t
def chat(go, model, messages, max_tokens=800, json_mode=True, temperature=0):
    with _lock:
        if spent() >= CAP_USD: raise CapReached(f"spend cap ${CAP_USD} reached")
    body = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature, "usage": {"include": True}, }
    if "haiku" in model: body["reasoning"] = {"effort": "none", "exclude": True}
    if json_mode: body["response_format"] = {"type": "json_object"}
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"], "Content-Type": "application/json", "X-Title": "KlickyMart crawler"})
    for a in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r: j = json.loads(r.read())
            break
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and a < 2: time.sleep(5 * (a + 1)); continue
            raise
    u = j.get("usage") or {}
    with _lock, open(LEDGER, "a") as f:
        f.write(json.dumps({"ts": int(time.time()), "go": go, "model": j.get("model", model), "in": u.get("prompt_tokens"), "out": u.get("completion_tokens"), "cost_usd": u.get("cost")}) + "\n")
    m = j["choices"][0]["message"]
    if m.get("content") is None: raise ValueError("empty content; finish=" + str(j["choices"][0].get("finish_reason")))
    return m["content"]
