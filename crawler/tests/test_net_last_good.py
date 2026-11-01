"""Network-error probes keep the last good checkout depth and retry sooner (early shopper finding F3)."""
import pathlib

SRC = (pathlib.Path(__file__).resolve().parent.parent / "build_v4.py").read_text()
ns = {}
exec(SRC[SRC.index("NET_RETRY_DAYS = 1"):SRC.index("def classify(")], ns)


def test_retry_sooner():
    assert ns["NET_RETRY_DAYS"] <= 2


def test_last_good_from_clean_previous_probe():
    prev = {"stage": "checkout", "first_blocker": {"kind": "none"}, "checked_at": "2026-10-20T00:00:00Z"}
    assert ns["last_good_of"](prev, 2, True) == {"co": 2, "stage": "checkout", "guest": True, "checked_at": "2026-10-20T00:00:00Z"}


def test_last_good_carried_through_repeated_network_errors():
    prev = {"first_blocker": {"kind": "network-error"}, "last_good": {"co": 3, "checked_at": "T"}}
    assert ns["last_good_of"](prev, None, None) == {"co": 3, "checked_at": "T"}
    assert ns["last_good_of"](None, 1, True) is None
