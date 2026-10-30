import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import pytest
import egress as gate

@pytest.fixture(autouse=True)
def real_resolver_semantics(monkeypatch):
    monkeypatch.setattr(gate, "_fakeip", False)

def fake(addrs):
    return lambda h, p: [(0, 0, 0, "", (a, 0)) for a in addrs]

@pytest.mark.parametrize("host", ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.5", "169.254.169.254", "100.64.0.1", "::1", "[fc00::1]",
                                  "0x7f.0.0.1", "2130706433", "0177.0.0.1", "localhost", "metadata.google.internal", "foo.local", "", None])
def test_private_and_odd_hosts_refused(host):
    assert not gate.public_host(host, resolve=fake(["127.0.0.1"]))

def test_dns_name_resolving_to_private_is_refused():
    assert not gate.public_host("evil.example", resolve=fake(["93.184.216.34", "10.0.0.5"]))
    assert not gate.public_host("evil.example", resolve=fake(["169.254.169.254"]))
    assert gate.public_host("shop.example", resolve=fake(["93.184.216.34"]))

def test_egress_check_refuses_schemes_and_credentials():
    for u in ["file:///etc/passwd", "ftp://x.example/", "http://user:pw@x.example/", "http://127.0.0.1:8080/", "http://[::1]/"]:
        with pytest.raises(gate.EgressRefused): gate.egress_check(u)
    gate.egress_check("data:text/plain,hi")

def test_fakeip_sandbox_mode_accepts_proxy_answers_only_for_names(monkeypatch):
    monkeypatch.setattr(gate, "_fakeip", True)
    assert gate.public_host("shop.example", resolve=fake(["198.18.0.1"]))
    assert not gate.public_host("198.18.0.1", resolve=fake(["198.18.0.1"]))  # literal benchmark-range IP still refused
    assert not gate.public_host("127.0.0.1", resolve=fake(["198.18.0.1"]))
    monkeypatch.setattr(gate, "_fakeip", False)
    assert not gate.public_host("shop.example", resolve=fake(["198.18.0.1"]))
