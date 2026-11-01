import os, sys
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, HERE)

def test_pq2_pending_sites_uses_shared_ua():
    import pending_sites, ua
    assert pending_sites.UA == ua.UA and "Agent/KlickyBot" in pending_sites.UA

def test_rubric_pay_src_values_current():
    row = [l for l in open(os.path.join(HERE, "..", "CRAWL-RUBRIC.md")) if l.startswith("| `pay_src`")][0]
    assert "rendered-pages" in row and "observed-checkout" not in row and "search-index" not in row
