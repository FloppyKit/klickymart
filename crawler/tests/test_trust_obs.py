"""M4 S3: crawler/trust.py. Every network call is mocked (fake fetch); nothing leaves the box."""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import pytest, trust_obs as T

AT = 1_793_000_000
VEC = "42d5d635c3361bc0f6bf73b46b644dd4defec618bb23c74cceaaee3a16b6a526"  # same vector in site/worker/test/trust-obs.test.ts  # secret-scan: allow (sha256 test vector shared with the Worker test, not a key)
RO = "https://rdap.org"
VS = "https://rdap.verisign.com/com/v1/domain/shop.com"

class Fake:
    def __init__(s, pages): s.pages, s.calls = pages, []
    def __call__(s, url):
        s.calls.append(url)
        v = s.pages.get(url)
        if v is None: return 404, ""
        return v if isinstance(v, tuple) else (200, v)

def pol(pages):
    f = Fake(pages); slept = []
    p = T.Polite(fetch=f, sleep=slept.append, clock=lambda: 0.0)
    return p, f, slept

def test_obs_id_matches_worker_vector():
    assert T.obs_id("shop.example", "first_seen", '{"at":"2026-01-01T00:00:00Z"}') == VEC

def test_robots_first_and_403_or_error_is_disallow():
    for st in (403, 401, 429, 500, None):
        p, f, _ = pol({"https://a.com/robots.txt": (st, "")})
        assert p.get("https://a.com/policies/refund-policy") == ("robots", "")
        assert f.calls == ["https://a.com/robots.txt"]  # nothing but robots was fetched
    p, f, _ = pol({"https://a.com/robots.txt": "User-agent: FloppyKitMapBot\nDisallow: /policies/\n"})
    assert p.get("https://a.com/policies/refund-policy")[0] == "robots"
    p, f, _ = pol({"https://a.com/robots.txt": (404, ""), "https://a.com/x": "ok"})
    assert p.get("https://a.com/x") == (200, "ok")  # no robots file = allowed

def test_never_fetches_amazon_target_or_cart():
    p, f, _ = pol({})
    for u in ("https://www.amazon.com/dp/B000000000", "https://target.com/p/x", "https://a.com/cart", "https://a.com/checkouts/1", "https://a.com/account/login"):
        with pytest.raises(ValueError): p.get(u)
    assert f.calls == []
    with pytest.raises(ValueError): T.live_fetch("https://a.com/checkout")

def test_per_host_spacing():
    t = [0.0]; slept = []
    p = T.Polite(fetch=lambda u: (200, ""), sleep=lambda s: slept.append(s), clock=lambda: t[0])
    p.get("https://a.com/1"); p.get("https://a.com/2")
    assert slept and all(s <= T.HOST_SPACING_S for s in slept) and len(slept) >= 2

def test_rdap_registration_date_mocked_follows_one_https_redirect():
    body = json.dumps({"events": [{"eventAction": "registration", "eventDate": "2019-05-02T10:00:00Z"}, {"eventAction": "expiration", "eventDate": "2030-01-01T00:00:00Z"}]})
    p, f, _ = pol({RO + "/robots.txt": (404, ""), RO + "/domain/shop.com": (302, VS), "https://rdap.verisign.com/robots.txt": (400, ""), VS: body})
    o = T.domain_registered(p, "www.shop.com", AT)
    assert json.loads(o["value_json"]) == {"registered": "2019-05-02"} and o["evidence_url"] == VS and o["method"] == "rdap"
    assert "https://rdap.verisign.com/robots.txt" in f.calls  # robots checked on the registry host too

def test_rdap_unknown_cases_are_null_never_false():
    p, _, _ = pol({RO + "/robots.txt": (403, "")})
    assert T.domain_registered(p, "shop.com", AT)["value_json"] == "null"  # robots 403 = disallow
    p, _, _ = pol({RO + "/robots.txt": (404, ""), RO + "/domain/shop.com": (302, "http://plain.example/x")})
    assert T.domain_registered(p, "shop.com", AT)["value_json"] == "null"  # non-https redirect not followed
    p, f, _ = pol({RO + "/robots.txt": (404, ""), RO + "/domain/shop.com": (302, VS), "https://rdap.verisign.com/robots.txt": (None, "")})
    assert T.domain_registered(p, "shop.com", AT)["value_json"] == "null" and VS not in f.calls  # registry robots timeout = disallow
    p, _, _ = pol({RO + "/robots.txt": (404, ""), RO + "/domain/shop.com": (500, "")})
    assert T.domain_registered(p, "shop.com", AT)["value_json"] == "null"
    p, _, _ = pol({RO + "/robots.txt": (404, ""), RO + "/domain/shop.com": '{"events": []}'})
    assert T.domain_registered(p, "shop.com", AT)["value_json"] == "null"  # no registration event

def test_registrable_domain():
    assert T.registrable("www.shop.co.uk") == "shop.co.uk" and T.registrable("a.b.shop.com") == "shop.com"

def test_rdap_daily_cap_and_known_skip(tmp_path):
    pre = [{"d": f"s{i}.com", "decision": "crawl"} for i in range(5)]
    p, f, _ = pol({})
    rows, _ = T.observe([r["d"] for r in pre], pre, p, str(tmp_path), known_registered=frozenset({"s0.com"}), at=AT, rdap_cap=2)
    assert sum(r["signal"] == "domain_registered" for r in rows) == 2
    assert not any(r["signal"] == "domain_registered" and r["domain"] == "s0.com" for r in rows)

def test_return_policy_quote_and_window():
    page = "<html><script>x</script><p>Welcome.</p><p>You may return items within 30 days of delivery for a full refund.</p></html>"
    p, _, _ = pol({"https://a.com/robots.txt": (404, ""), "https://a.com/policies/refund-policy": page})
    o = T.return_policy(p, "a.com", AT)
    assert json.loads(o["value_json"]) == {"window_days": 30} and "30 days" in o["quote"] and o["evidence_url"].endswith("refund-policy")
    p, _, _ = pol({"https://a.com/robots.txt": (404, "")})
    assert T.return_policy(p, "a.com", AT)["value_json"] == "null"

def test_contact_phone_address():
    page = "<p>Contact us: 1200 Main Street, Lawrence KS. Call (785) 555-0100.</p>"
    p, _, _ = pol({"https://a.com/robots.txt": (404, ""), "https://a.com/pages/contact": page})
    o = T.contact(p, "a.com", AT)
    assert json.loads(o["value_json"]) == {"phone": True, "address": True} and "Main Street" in o["quote"]

def test_reseller_signs():
    prods = {"products": [{"title": "Pasta", "body_html": "Ships from Amazon. ASIN: B07XYZ1234", "images": [{"src": "https://m.media-amazon.com/images/I/x.jpg"}]}]}
    p, _, _ = pol({"https://a.com/robots.txt": (404, ""), "https://a.com/products.json?limit=50": json.dumps(prods)})
    o = T.reseller(p, "a.com", AT)
    assert json.loads(o["value_json"]) == {"signs": ["asin", "amazon-image", "amazon-fulfilment"]} and o["quote"]
    p, _, _ = pol({"https://b.com/robots.txt": (404, ""), "https://b.com/products.json?limit=50": json.dumps({"products": [{"title": "Rice", "body_html": "Local"}]})})
    assert json.loads(T.reseller(p, "b.com", AT)["value_json"]) == {"signs": []}

def test_first_seen_from_our_data_only(tmp_path):
    (tmp_path / "records.ndjson").write_text(json.dumps({"d": "www.a.com", "ts": 1_780_000_000}) + "\n")
    (tmp_path / "offers.ndjson").write_text(json.dumps({"d": "a.com", "t": "2026-05-01T00:00:00Z"}) + "\n")
    o = T.first_seen("a.com", str(tmp_path), AT)
    assert json.loads(o["value_json"]) == {"at": "2026-05-01T00:00:00Z"} and o["method"] == "own-ledger"  # earliest of the two
    assert json.loads(T.first_seen("new.com", str(tmp_path), AT)["value_json"]) == {"at": T.iso(AT)}

def test_observe_respects_widen_gate_and_link_only(tmp_path):
    pre = [{"d": "ok.com", "decision": "crawl"}, {"d": "no.com", "decision": "skip"}, {"d": "amazon.com", "decision": "crawl"}]
    p, f, _ = pol({})
    rows, skipped = T.observe(["ok.com", "no.com", "amazon.com", "unlisted.com"], pre, p, str(tmp_path), at=AT)
    assert {r["domain"] for r in rows} == {"ok.com"} and set(skipped) == {"no.com", "amazon.com", "unlisted.com"}
    assert not any("amazon" in u or "no.com" in u for u in f.calls)

def test_row_format_and_sql(tmp_path):
    o = T.obs("a.com", "return_policy", {"window_days": 30}, "shopify-policy-page", "https://a.com/policies/refund-policy", "It's 30 days", AT)
    assert sorted(o) == ["domain", "evidence_url", "id", "method", "observed_at", "quote", "signal", "value_json"]
    sql = T.sql_for([o])
    assert sql.startswith("INSERT OR IGNORE INTO store_trust_obs") and "It''s 30 days" in sql and "UPDATE" not in sql and "DELETE" not in sql

def test_append_only_tables_never_updated_or_deleted_in_worker_src():
    import glob, re
    src = os.path.join(os.path.dirname(__file__), "..", "..", "site", "worker", "src")
    rx = re.compile(r"(UPDATE|DELETE\s+FROM)\s+(store_trust_obs|live_seen_domains|snapshot_nodes|snapshot_leaves)\b", re.I)
    hits = [f for f in glob.glob(os.path.join(src, "**", "*.ts"), recursive=True) if rx.search(open(f).read())]
    assert hits == []

def test_trust_ranking_never_imports_tip_modules():
    import re
    src = os.path.join(os.path.dirname(__file__), "..", "..", "site", "worker", "src")
    for f in ("trust-tier.ts", "offers.ts", "trust-obs.ts"):
        imports = re.findall(r'from\s+"([^"]+)"', open(os.path.join(src, f)).read())
        assert not any(re.search(r"tip", i) for i in imports), (f, imports)
