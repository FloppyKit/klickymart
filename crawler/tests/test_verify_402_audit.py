import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from verify_402 import l402_challenge, parse

def test_p2_3_linear_on_adversarial_input():
    for s in ("L402 " + "a" * 20000, "L402 " + "a " * 10000, "L402 " + "a=" * 10000, "L402 macaroon=" + "x" * 20000):
        t = time.perf_counter(); l402_challenge(s); assert time.perf_counter() - t < 0.1, s[:20]

def test_p2_4_free_text_is_not_a_challenge():
    assert l402_challenge("text says L402 macaroon=x invoice=lnbc1") is None
    assert l402_challenge('L402 macaroon="AGIAJEemVQUTEyNCR0exk7ek", invoice="notaninvoice"') is None
    assert parse(402, {}, "please pay: L402 macaroon=abc invoice=lnbc10n1pxyz").get("proto") != "l402"

def test_p2_4_header_challenge_still_parses():
    c = l402_challenge('L402 macaroon="AGIAJEemVQUTEyNCR0exk7ek", invoice="lnbc10n1pjexample"')
    assert c and c["scheme"] == "L402" and c["invoice"].startswith("lnbc")
    c = l402_challenge('Bearer realm="x", LSAT macaroon="m1", invoice="lnbc1u1pqxyz"')
    assert c and c["scheme"] == "LSAT"
    assert parse(402, {"WWW-Authenticate": 'L402 macaroon="m", invoice="lnbc10n1pq"'}, "")["proto"] == "l402"
