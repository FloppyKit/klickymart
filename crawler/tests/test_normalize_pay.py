import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from normalize_pay import normalize, chip_labels, label

def test_bnpl_providers_get_distinct_labels():
    assert label("bnpl:afterpay") == "Buy now pay later (Afterpay)"
    assert label("bnpl:klarna") != label("bnpl:afterpay")

def test_chip_labels_dedupe_across_scopes():
    r = {"pay_online": ["card", "bnpl:klarna"], "pay_instore": ["card", "bnpl:klarna"], "pay_unscoped": ["bnpl:klarna"]}
    assert chip_labels(r) == ["Card", "Buy now pay later (Klarna)"]

def test_normalize_dedupes_lists_and_quotes():
    q = {"c": "card", "url": "u", "q": "x"}
    r = normalize({"pay": ["card", "card", "pp"], "pay_q": [q, dict(q)], "evu": ["u", "u"]})
    assert r["pay"] == ["card", "pp"] and len(r["pay_q"]) == 1 and r["evu"] == ["u"]
