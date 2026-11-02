import importlib.util, pathlib, pytest
p = pathlib.Path(__file__).resolve().parents[2] / "site/scripts/km-takedown.py"
spec = importlib.util.spec_from_file_location("km_takedown", p); kt = importlib.util.module_from_spec(spec); spec.loader.exec_module(kt)
PK, E1, E2 = "a" * 64, "b" * 64, "c" * 64  # secret-scan: allow (synthetic ids)

def test_valid_notice_hash_only_and_hides():
    sql = kt.build_sql({"claimant_email": "Claims@Example.com ", "pubkey": PK, "event_ids": [E1, E2, E1], "valid": True, "received_at": 100}, b"NOTICE TEXT secret-name")
    assert "NOTICE" not in sql and "secret-name" not in sql and "example.com" not in sql.lower()
    assert kt.sha(b"claims@example.com") in sql and sql.count("takedown_hides") == 2
    assert all(l.startswith("INSERT OR IGNORE") for l in sql.strip().splitlines())

def test_invalid_notice_logs_but_hides_nothing():
    sql = kt.build_sql({"claimant_email": "x@y.z", "pubkey": PK, "event_ids": [E1], "valid": False, "received_at": 1}, b"n")
    assert "takedown_hides" not in sql and ", 0, 1);" in sql

@pytest.mark.parametrize("bad", [{"pubkey": "zz"}, {"event_ids": ["1'; DROP TABLE x;--"]}, {"event_ids": []}])
def test_rejects_bad_input(bad):
    d = {"claimant_email": "x@y.z", "pubkey": PK, "event_ids": [E1], "valid": True, "received_at": 1, **bad}
    with pytest.raises(ValueError): kt.build_sql(d, b"n")

def test_restore_is_append_only_hash_only():
    nh = "d" * 64  # secret-scan: allow (synthetic)
    sql = kt.build_restore_sql({"notice_hash": nh, "event_ids": [E1, E1], "restored_at": 5}, b"COUNTER from bob@example.com")
    lines = sql.strip().splitlines()
    assert len(lines) == 1 and lines[0].startswith("INSERT OR IGNORE INTO takedown_restores")
    assert "COUNTER" not in sql and "bob" not in sql and kt.sha(b"COUNTER from bob@example.com") in sql
    assert "DELETE" not in sql.upper() and "UPDATE" not in sql.upper()

@pytest.mark.parametrize("bad", [{"notice_hash": "x"}, {"event_ids": ["'; DROP"]}, {"event_ids": []}])
def test_restore_rejects_bad_input(bad):
    with pytest.raises(ValueError): kt.build_restore_sql({"notice_hash": "d" * 64, "event_ids": [E1], "restored_at": 1, **bad}, b"c")

def test_cli_restore(tmp_path):
    import json, subprocess, sys
    (tmp_path / "c.eml").write_bytes(b"counter")
    (tmp_path / "r.json").write_text(json.dumps({"counter_file": str(tmp_path / "c.eml"), "notice_hash": "d" * 64, "event_ids": [E1], "restored_at": 9}))
    out = subprocess.run([sys.executable, str(p), "--restore", str(tmp_path / "r.json")], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0 and "takedown_restores" in out.stdout
