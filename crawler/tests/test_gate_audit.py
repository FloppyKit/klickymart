import os, sys, pytest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import gate

@pytest.fixture(autouse=True)
def offline(monkeypatch, tmp_path):
    monkeypatch.setattr(gate._egress, "public_host", lambda h, resolve=None: True)
    monkeypatch.setattr(gate, "O", lambda *p: os.path.join(str(tmp_path), *p))
    monkeypatch.setattr(gate, "_robots_ok", lambda url: False)   # never fetch robots in tests
    monkeypatch.setattr(gate, "verdict", lambda d: None)

def test_p1_1_rdap_prefix_is_not_an_api_host():
    with pytest.raises(gate.GateRefused): gate.check("https://rdap.attacker.shop/products/1")

def test_p1_1_any_klickymart_subdomain_is_not_an_api_host():
    with pytest.raises(gate.GateRefused): gate.check("https://evil.klickymart.com/x")

def test_p1_1_http_to_allowed_host_refused():
    for u in ("http://klickymart.com/pending.json", "http://openrouter.ai/api/v1/chat/completions", "http://rdap.org/domain/x.com"):
        with pytest.raises(gate.GateRefused): gate.check(u)

def test_p1_1_lookalike_refused():
    with pytest.raises(gate.GateRefused): gate.check("https://klickymart.com.evil.tld/pending.json")

def test_p1_1_exact_hosts_allowed_over_https():
    for u in ("https://klickymart.com/pending.json", "https://www.klickymart.com/ucp/quote-profile.json",
              "https://openrouter.ai/api/v1/chat/completions", "https://rdap.org/domain/example.com"):
        assert gate.check(u) == "api host"

SECRET_URL = "ftp://u:TOKENxyz123@h.example/p?macaroon=MACsecret987&x=1"  # secret-scan: allow (fake credential in a test URL)

def test_p2_1_reason_and_url_redacted_for_non_http(tmp_path):
    with pytest.raises(gate.GateRefused) as ei: gate.check(SECRET_URL)
    log = open(os.path.join(str(tmp_path), "runs", "gate-refusals.log")).read()
    for text in (str(ei.value), log):
        assert "TOKENxyz123" not in text and "MACsecret987" not in text and "macaroon=" not in text, text

def test_p2_1_redact_helper_any_scheme():
    r = gate.redact("see ftp://a:b@h/x?macaroon=M1 and https://u:p@shop.example/c?token=T1")
    assert "M1" not in r and "a:b@" not in r and "u:p@" not in r and "T1" not in r

def test_p2_2_refusal_chains_cause():
    with pytest.raises(gate.GateRefused) as ei: gate.check(SECRET_URL)
    assert isinstance(ei.value.__cause__, gate._egress.EgressRefused)
    with pytest.raises(gate.GateRefused) as ei: gate.vetted_addr("localhost", "https://localhost/")
    assert isinstance(ei.value.__cause__, gate._egress.EgressRefused)
