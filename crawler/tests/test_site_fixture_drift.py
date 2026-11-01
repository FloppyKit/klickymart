"""Post-verify 2026-11-01: site/worker/src/fixture-data.ts drifted from data/*.ndjson; `npm run dev` predev rewrote it."""
import os, shutil, subprocess, pytest
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def test_embedded_fixtures_match_generator():
    if not shutil.which("node"): pytest.skip("node unavailable")
    r = subprocess.run(["node", os.path.join(ROOT, "site", "scripts", "embed-fixtures.js"), "--check"], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout + r.stderr
