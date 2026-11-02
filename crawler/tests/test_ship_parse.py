"""M4 S5: deterministic shipping-policy parser + fetch path. Fixtures in tests/fixtures/ship_policies/ are SYNTHETIC
(typical Shopify policy phrasing written for these tests), not real store pages. All network is mocked."""
import glob, json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import pytest, ship_parse as S, trust_obs as T

FX = sorted(glob.glob(os.path.join(os.path.dirname(__file__), "fixtures", "ship_policies", "*.json")))

def norm_rules(rules):
    out = []
    for r in rules:
        x = [r["type"], r.get("usd"), r.get("min_usd"), r["region"]]
        x = [float(v) if isinstance(v, (int, float)) else v for v in x]
        if r.get("conditions"): x.append("c")
        out.append(x)
    return sorted(out, key=json.dumps)

def expected(e):
    return sorted([[float(v) if isinstance(v, (int, float)) else v for v in x] for x in e], key=json.dumps)

def score():
    ok = [os.path.basename(f) for f in FX if norm_rules(S.parse_text(json.load(open(f))["text"])[0]) == expected(json.load(open(f))["expect"])]
    return ok

@pytest.mark.parametrize("f", FX, ids=[os.path.basename(f) for f in FX])
def test_fixture(f):
    fx = json.load(open(f))
    rules, _ = S.parse_text(fx["text"])
    assert norm_rules(rules) == expected(fx["expect"])
    for r in rules: assert r["quote"] and r["quote"] in fx["text"]  # verbatim quote

def test_fixture_coverage_reported():
    ok = score()
    print(f"\nship_parse fixtures parsed exactly: {len(ok)}/{len(FX)} (synthetic fixtures)")
    assert len(FX) == 20 and len(ok) == len(FX)

def test_never_guesses_a_price():
    for t in ["Shipping fees apply.", "Calculated at checkout.", "Shipping is cheap!", "Orders ship free sometimes.", "We ship worldwide for $20 to Canada."]:
        rules, _ = S.parse_text(t)
        assert all(r.get("usd") is None and r.get("min_usd") is None for r in rules), (t, rules)

def test_jsonld_shipping_details():
    ld = {"@context": "https://schema.org", "@type": "Product", "offers": {"@type": "Offer", "shippingDetails": [
        {"@type": "OfferShippingDetails", "shippingRate": {"@type": "MonetaryAmount", "value": "5.99", "currency": "USD"}, "shippingDestination": {"@type": "DefinedRegion", "addressCountry": "US"}},
        {"@type": "OfferShippingDetails", "shippingRate": {"value": "20", "currency": "USD"}, "shippingDestination": {"addressCountry": "CA"}},
        {"@type": "OfferShippingDetails", "shippingRate": {"value": "0", "currency": "USD"}, "shippingDestination": {"addressCountry": "US"}},
        {"@type": "OfferShippingDetails", "shippingRate": {"value": "4", "currency": "EUR"}, "shippingDestination": {"addressCountry": "US"}}]}}
    html = f'<script type="application/ld+json">{json.dumps(ld)}</script>'
    r = S.rules_from_ld(html)
    assert [(x["type"], x.get("usd")) for x in r] == [("flat", 5.99), ("free", None)] and all(x["method"] == "jsonld-shippingDetails" for x in r)

class Fake:
    def __init__(s, pages): s.pages, s.calls = pages, []
    def __call__(s, url):
        s.calls.append(url); v = s.pages.get(url)
        return (404, "") if v is None else v if isinstance(v, tuple) else (200, v)

def test_fetch_robots_first_and_disallow_means_unknown():
    f = Fake({"https://a.com/robots.txt": (403, "")})
    o = S.shipping_obs(T.Polite(fetch=f, sleep=lambda s: None, clock=lambda: 0.0), "a.com", 1_793_000_000)
    assert o["rules_json"] == "[]" and o["src"] is None and f.calls == ["https://a.com/robots.txt"]

def test_fetch_policy_page_and_row_format():
    page = "<html><h1>Shipping policy</h1><p>Free shipping on all orders over $40.</p><p>We ship to all 50 states.</p></html>"
    f = Fake({"https://a.com/robots.txt": (404, ""), "https://a.com/policies/shipping-policy": page})
    o = S.shipping_obs(T.Polite(fetch=f, sleep=lambda s: None, clock=lambda: 0.0), "a.com", 1_793_000_000)
    assert sorted(o) == ["checked_at", "domain", "id", "rules_json", "ships_us", "src"] and o["ships_us"] == 1
    assert json.loads(o["rules_json"])[0]["min_usd"] == 40.0
    assert all("cart" not in u and "checkout" not in u for u in f.calls)
    sql = S.sql_for([o]); assert sql.startswith("INSERT OR IGNORE INTO ship_policy_obs") and "UPDATE" not in sql

HELD = sorted(glob.glob(os.path.join(os.path.dirname(__file__), "fixtures", "ship_policies_heldout", "*.json")))

def test_heldout_never_wrong_and_report_coverage():
    """Held-out synthetic fixtures (written after tuning): each result must be exact or carry no price (unknown). A price
    that differs from the policy text fails. The exact-match fraction is reported, not required."""
    exact = 0
    for f in HELD:
        fx = json.load(open(f)); got = norm_rules(S.parse_text(fx["text"])[0]); want = expected(fx["expect"])
        if got == want: exact += 1; continue
        priced = [g for g in got if g[1] is not None or g[2] is not None]
        assert all(g in want for g in priced), (os.path.basename(f), got, want)
    print(f"\nship_parse held-out fixtures parsed exactly: {exact}/{len(HELD)} (synthetic, not tuned against)")
