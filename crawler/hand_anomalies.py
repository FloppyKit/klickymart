#!/usr/bin/env python3
"""Ledger of anomalous hand overrides, keyed by who set them (btc_grade_hand_by).

Append-only JSONL: a 'record' event opens an entry (status 'open'); a 'clear' event, written only by clear(), closes it.
Nothing is rewritten in place. Default path crawler/out/hand-anomalies.jsonl (untracked); KM_HAND_ANOMALIES overrides.
The ledger is decoupled from store grades: an open entry never keeps a record's btc_grade_needs_review set."""
import datetime, hashlib, json, os, threading

HERE = os.path.dirname(os.path.abspath(__file__))
_lock = threading.Lock()

def path():
    return os.environ.get("KM_HAND_ANOMALIES") or os.path.join(HERE, "out", "hand-anomalies.jsonl")

def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def entry_id(author, domain, kind, hand_at):
    return hashlib.sha256(json.dumps([author, domain, kind, hand_at]).encode()).hexdigest()[:16]

def _events(p):
    if not os.path.exists(p): return []
    with open(p) as f: return [json.loads(l) for l in f if l.strip()]

def _append(p, ev):
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    with open(p, "a") as f: f.write(json.dumps(ev, separators=(",", ":")) + "\n")

def record(entry, path=None):
    """Open an entry; idempotent on (author, domain, kind, hand_at). Returns its id."""
    p = path or globals()["path"]()
    e = {k: entry.get(k) for k in ("author", "domain", "kind", "hand_at", "clamped_to", "seen_at")}
    eid = entry_id(e["author"], e["domain"], e["kind"], e["hand_at"])
    with _lock:
        if any(ev.get("event") == "record" and ev.get("id") == eid for ev in _events(p)): return eid
        _append(p, dict(e, event="record", id=eid, status="open", seen_at=e["seen_at"] or _now()))
    return eid

def _state(p):
    entries, cleared = {}, set()
    for ev in _events(p):
        if ev.get("event") == "record": entries.setdefault(ev["id"], ev)
        elif ev.get("event") == "clear": cleared.add(ev["id"])
    return entries, cleared

def open_by_author(path=None):
    """{author: [open entries]}."""
    entries, cleared = _state(path or globals()["path"]())
    out = {}
    for eid, e in entries.items():
        if eid not in cleared: out.setdefault(e.get("author"), []).append(e)
    return out

def clear(id, cleared_by, note, path=None):
    """The only way an entry closes: appends a 'clear' event. KeyError for an unknown id."""
    p = path or globals()["path"]()
    with _lock:
        entries, cleared = _state(p)
        if id not in entries: raise KeyError(id)
        _append(p, {"event": "clear", "id": id, "status": "cleared", "cleared_by": cleared_by, "note": note, "cleared_at": _now()})
