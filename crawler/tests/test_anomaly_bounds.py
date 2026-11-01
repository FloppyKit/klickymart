import datetime, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import btc_grade
from btc_grade import apply

BASE = datetime.datetime(2099, 1, 1, 0, 0, tzinfo=datetime.timezone.utc)
def variants(n=50):
    out = []
    for i in range(n):
        tz = datetime.timezone(datetime.timedelta(minutes=15 * (i - 25)))
        local = BASE.astimezone(tz)
        out.append(local.isoformat(timespec=("seconds", "milliseconds", "microseconds")[i % 3]))
    out[0] = "2099-01-01T00:00:00Z"; out[1] = "2099-01-01"; out[2] = "2099-01-01T00:00"
    return out

def run(values):
    r = {"d": "s.example", "btc": 0, "btc_src": "hand", "btc_grade_hand_by": "kb", "btc_grade_hand_evidence": "https://s.example/pay"}
    sink = lambda e: None
    for v in values:
        r = apply(dict(r, btc_grade_hand_at=v), today="2026-11-01T00:00:00Z", anomaly_sink=sink)
    return r

def test_format_variants_dedupe_to_one():
    vs = variants(); assert len(set(vs)) == 50
    r = run(vs)
    assert len(r["btc_grade_anomalies"]) == 1 and not r.get("btc_grade_anomalies_truncated")
    assert r["btc_grade_anomalies"][0]["hand_at_norm"] == "2099-01-01T00:00:00+00:00"

def test_distinct_values_capped():
    vs = [(BASE + datetime.timedelta(days=i)).isoformat() for i in range(50)]
    r = run(vs); a = r["btc_grade_anomalies"]
    assert len(a) == btc_grade.MAX_ANOMALIES == 10
    assert a[0]["hand_at"] == vs[0]                                     # first kept
    assert [x["hand_at"] for x in a[1:]] == vs[-9:]                     # most recent kept
    assert r["btc_grade_anomalies_truncated"] == 40
