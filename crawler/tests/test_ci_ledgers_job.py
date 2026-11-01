"""r5-1: the ledgers CI job compares against the right base. Real CI can't run here; this checks the workflow text/YAML."""
import os, re
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WF = os.path.join(REPO, ".github", "workflows", "site.yml")

def _job(text, name):
    m = re.search(rf"(?ms)^  {name}:\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)", text)
    assert m, f"job {name} missing"; return m.group(1)

def test_ledgers_job_base_and_permissions():
    text = open(WF).read()
    try:
        import yaml
        wf = yaml.safe_load(text); jobs = wf["jobs"]; on = wf.get("on", wf.get(True))
        assert "pull_request" in on and "push" in on
        assert jobs["ledgers"]["permissions"] == {"contents": "read"}
    except ImportError:
        pass
    j = _job(text, "ledgers")
    assert re.search(r"(?m)^    permissions:\n      contents: read$", j)
    assert "fetch-depth: 0" in j
    assert "${{ github.event.before }}" in j
    assert "${{ github.event.pull_request.base.sha }}" in j
    assert re.search(r"0{40}", j) and "git merge-base origin/main HEAD" in j   # new-branch fallback
    assert "python3 crawler/check_append_only.py \"$base\"" in j
    assert re.search(r"(?m)^  pull_request:", text)
    assert "if: github.event_name == 'push'" in _job(text, "site")          # site job keeps its one-run-per-push rule
