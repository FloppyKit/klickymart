import os, tempfile, pytest
_TMP = tempfile.mkdtemp(prefix="km-ledgers-")
# hermetic: hard-set (not setdefault) so a shell-exported path can never make tests touch a real ledger/store
os.environ["KM_HAND_ANOMALIES"] = os.path.join(_TMP, "hand-anomalies.jsonl")
os.environ["KM_HAND_FIRST_SEEN"] = os.path.join(_TMP, "hand-first-seen.jsonl")

@pytest.fixture(autouse=True)
def _ledger_env(monkeypatch, tmp_path):
    monkeypatch.setenv("KM_HAND_ANOMALIES", str(tmp_path / "hand-anomalies.jsonl"))
    monkeypatch.setenv("KM_HAND_FIRST_SEEN", str(tmp_path / "hand-first-seen.jsonl"))
