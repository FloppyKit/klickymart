import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from policy_restrictions import restrictions, analyze

CC = ("Contact Support : Email support@cryptocloaks.com within 30 days of receipt. "
      "We do not accept general 'change of mind' returns. "
      "Defective/Damaged on Arrival : Report promptly within 15 days per product. "
      "A $10 restocking fee applies to approved returns of working or unopened miners.")

def test_cryptocloaks_restrictions():
    kinds = {r["kind"]: r for r in restrictions(CC, "https://www.cryptocloaks.com/refund_returns-2/")}
    assert "no-change-of-mind" in kinds
    assert kinds["defect-window"]["days"] == 15
    assert kinds["restocking-fee"]["usd"] == 10.0
    assert all(r["q"] in CC for r in kinds.values())

def test_bose_conflict_between_pages():
    a = analyze([("https://www.bose.com/returns", "You may return items within 30 days of receipt."),
                 ("https://www.bose.com/p/x", "90-day return policy Try it for 90 days to make sure it's right for you.")], 30)
    assert {c["days"] for c in a["conflicting_sources"]} == {30, 90}

def test_no_false_conflict():
    assert analyze([("u", "Returns within 30 days.")], 30)["conflicting_sources"] == []
    assert restrictions("Free returns within 30 days.") == []
