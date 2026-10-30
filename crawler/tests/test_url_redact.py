import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from url_redact import redact, clean_url, findings, affected

FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJ4In0.c2lnbmF0dXJlc2lnbmF0dXJl"

def test_login_redirect_query_is_stripped():
    u = "https://shopify.com/authentication/1/login?client_id=abc&redirect_uri=%2Fx%3Fbuyer_flags%3D" + FAKE_JWT + "&state=hWNIabcdefgh#frag"
    assert clean_url(u) == "https://shopify.com/authentication/1/login"

def test_session_ids_and_userinfo_stripped():
    assert clean_url("https://user:pw@www.vinted.com/items/1?homepage_session_id=4ae7xxxx") == "https://www.vinted.com/items/1"

def test_record_walk_and_bare_tokens():
    r = {"checkout_map": {"steps": [{"url": "https://a.example/p?token=" + FAKE_JWT}], "note": "saw " + FAKE_JWT + " and shpat_" + "0" * 32}, "n": 3}
    out = redact(r)
    assert out["checkout_map"]["steps"][0]["url"] == "https://a.example/p"
    assert "eyJ" not in str(out) and "shpat_" not in str(out) and out["n"] == 3
    f = findings(r)
    assert {p for p, _, _ in f} == {"$.checkout_map.steps[0].url", "$.checkout_map.note"}
    assert all(len(x) <= 4 for _, _, x in f)

def test_clean_records_unchanged():
    r = {"d": "shop.example", "url": "https://shop.example/cart", "tos_q": "no bots"}
    assert redact(r) == r

def test_navigational_params_kept_tracking_dropped():
    assert clean_url("https://s.example/p?variant=123&utm_source=x&_r=AAAA") == "https://s.example/p?variant=123"
    assert not affected({"u": "https://s.example/p?variant=1&utm_source=x"})
    assert affected({"u": "https://s.example/p?_x_sessn_id=abcdef1234"})
    assert affected({"u": "https://aliexpress.example/?x5secdata=" + "a" * 40})

def test_shopify_checkout_path_token():
    u = "https://shop.example/checkouts/cn/hWNIabcdefghijklmnopqrstuv/en-us?_r=AQABxyz&auto_redirect=false"
    assert clean_url(u) == "https://shop.example/checkouts/cn/[redacted]/en-us"
    assert affected({"u": u})
