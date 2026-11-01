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
