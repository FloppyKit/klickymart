"""M4 S1: widen gate (crawler/widen_gate.py, scripts/km-widen-check.sh). Local fixtures only; no network."""
import json, os, subprocess, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import widen_gate as g

STATUS_OK = """== CI
  CHECK ci_green_on_head: PASS
-- Usage today (UTC day, account-wide) vs 50% of free-tier daily limits
  Workers requests            347 /    100,000    0.3%  OK
  DO requests                   0 /    100,000    0.0%  OK
  DO duration GB-s            0.0 /     13,000    0.0%  OK
  D1 rows read             10,737 /  5,000,000    0.2%  OK
  D1 rows written             271 /    100,000    0.3%  OK
"""
ROW = lambda d, **k: {"d": d, "robots_status": 200, "robots_allows": True, "tos": "ok", "decision": "crawl", **k}
PLAN = lambda d, **k: {"d": d, "requests": 6, "spacing_s": 2, **k}

def run(domains, rows=None, plan=None, status=STATUS_OK, last=None):
    rows = rows if rows is not None else [ROW(d) for d in domains]
    plan = plan if plan is not None else [PLAN(d) for d in domains]
    return g.gate(domains, rows, plan, status, last)

def test_all_good_passes():
    assert run(["a.com", "www.b.com"]) == []

def test_missing_precrawl_row_refused():
    assert any("no precrawl row" in f for f in run(["a.com", "c.com"], rows=[ROW("a.com")]))

def test_skip_decision_and_robots_and_terms():
    f = run(["a.com", "b.com", "c.com"], rows=[ROW("a.com", decision="skip"), ROW("b.com", robots_allows=False, robots_status=403), ROW("c.com", tos="bans-automation")])
    assert len(f) == 3 and "decision" in f[0] and "robots" in f[1] and "terms" in f[2]

def test_amazon_target_always_refused_even_if_marked_crawl():
    f = run(["amazon.com", "www.target.com", "smile.amazon.com"])
    assert len([x for x in f if "link-out only" in x]) == 3

def test_robots_decision_matches_worker_rule():
    assert g.robots_decision(200, True) and not g.robots_decision(200, False)
    assert g.robots_decision(404, None)
    for s in (401, 403, 429, 500, 503, None): assert not g.robots_decision(s, None)

def test_rate_limits():
    f = run(["a.com", "b.com", "c.com"], plan=[PLAN("a.com", requests=11), PLAN("b.com", spacing_s=1), PLAN("c.com", crawl_delay_s=5)])
    assert any("11 requests" in x for x in f) and any("b.com: spacing" in x for x in f) and any("c.com: spacing 2.0s < 5.0s" in x for x in f)

def test_domain_without_rate_plan_refused():
    assert any("no rate plan" in f for f in run(["a.com"], plan=[]))

def test_budget_over_50pct_refused():
    hot = STATUS_OK.replace("  D1 rows written             271 /", "  D1 rows written          49,990 /")
    assert any("D1 rows written" in f for f in run(["a.com", "b.com"], status=hot))  # 49,990 + 14 > 50,000

def test_budget_unknown_refused():
    assert any("usage unknown" in f for f in run(["a.com"], status="  CHECK ci_green_on_head: PASS\n"))

def test_ci_not_green_refused():
    assert any("CI on HEAD: FAIL" in f for f in run(["a.com"], status=STATUS_OK.replace("ci_green_on_head: PASS", "ci_green_on_head: FAIL")))

def test_stop_rule():
    assert any("no widening" in f for f in run(["a.com"], last={"total": 100, "blocked": 9, "error": 2}))
    assert run(["a.com"], last={"total": 100, "blocked": 10, "error": 0}) == []

def test_shell_wrapper_exit_codes(tmp_path):
    root = os.path.join(os.path.dirname(__file__), "..", "..")
    (tmp_path / "d.txt").write_text("a.com\n# comment\n")
    (tmp_path / "p.jsonl").write_text(json.dumps(ROW("a.com")) + "\n")
    (tmp_path / "plan.jsonl").write_text(json.dumps(PLAN("a.com")) + "\n")
    (tmp_path / "s.txt").write_text(STATUS_OK)
    env = {**os.environ, "KM_STATUS_FILE": str(tmp_path / "s.txt")}
    cmd = [os.path.join(root, "scripts", "km-widen-check.sh"), str(tmp_path / "d.txt"), str(tmp_path / "p.jsonl"), str(tmp_path / "plan.jsonl")]
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and "widen-gate: PASS" in r.stdout
    (tmp_path / "d.txt").write_text("a.com\ntarget.com\n")
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=60)
    assert r.returncode == 1 and "FAIL target.com" in r.stdout
