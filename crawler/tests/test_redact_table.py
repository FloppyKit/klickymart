import os, sys, pytest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import egress, gate

MAC = "AgEDbG5kAvgBAwoQSecretMacaroonBytes0123"
PRE = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"  # secret-scan: allow (fake test prefix)
CASES = [
    ("auth-l402", f"Authorization: L402 {MAC}:{PRE}", [MAC, PRE]),
    ("auth-lsat", f"authorization: LSAT {MAC}:{PRE}", [MAC, PRE]),
    ("auth-bearer-hdr", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def", ["eyJhbGciOiJIUzI1NiJ9"]),
    ("auth-basic", "Authorization: Basic dXNlcjpwYXNzd29yZA==", ["dXNlcjpwYXNzd29yZA"]),
    ("bearer-free", "sent Bearer sk_live_ABCDEF1234567890 to host", ["sk_live_ABCDEF1234567890"]),
    ("json-macaroon", f'{{"macaroon": "{MAC}", "x": 1}}', [MAC]),
    ("json-preimage", f'{{"preimage":"{PRE}"}}', [PRE]),
    ("json-token", '{"token" : "tok_SECRET_998877"}', ["tok_SECRET_998877"]),
    ("urlenc-macaroon", f"q=macaroon%3D{MAC}%26x%3D1", [MAC]),
    ("token-colon", "token: tok_SECRET_112233 rest", ["tok_SECRET_112233"]),
    ("token-eq", "see token=tok_SECRET_445566 here", ["tok_SECRET_445566"]),
    ("url-path-b64", "https://api.example.com/api/sk-AbCdEfGhIjKlMnOpQrStUvWx/items", ["sk-AbCdEfGhIjKlMnOpQrStUvWx"]),
    ("url-path-hex", f"https://h.example/v1/{PRE}/x", [PRE]),
    ("url-path-b64url-dash", "https://h.example/v1/AbCdEf01234-56789XyZ0123456qWeRtY/x", ["AbCdEf01234-56789XyZ0123456qWeRtY"]),
    ("url-path-b64url-under", "https://h.example/dl/Zm9vYmFyQmF6_cXV4UXV1eDEyMzQ1Njc4OTA/x", ["Zm9vYmFyQmF6_cXV4UXV1eDEyMzQ1Njc4OTA"]),
    ("url-userinfo-query", "ftp://u:SECRETpw@x.com/a?macaroon=SECRETmac#frag", ["SECRETpw", "SECRETmac", "frag"]),
]

@pytest.mark.parametrize("name,text,secrets", CASES, ids=[c[0] for c in CASES])
def test_redact_table(name, text, secrets):
    for f in (egress.redact, gate.redact):
        out = f(text)
        for s in secrets: assert s not in out, (name, out)

@pytest.mark.parametrize("u", ["https://shop.example/products/Mens-Running-Shoe-Blue-Size10-2024/",
                               "https://shop.example/p/Womens_Trail_Jacket_XL2024_Red/details"])
def test_readable_slugs_not_redacted(u):
    assert egress.redact(u) == u

def test_redact_keeps_plain_text_and_short_paths():
    assert egress.redact("https://shop.example/products/123/blue-shirt") == "https://shop.example/products/123/blue-shirt"
    assert egress.redact("egress: not a public internet host: localhost") == "egress: not a public internet host: localhost"
