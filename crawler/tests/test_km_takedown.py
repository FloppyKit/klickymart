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
