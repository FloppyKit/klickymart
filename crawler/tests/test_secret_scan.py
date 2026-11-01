"""Site secret scan (site/scripts/secret-scan.py): guard code passes, real-looking FAKE secrets are caught.
All test values are generated here (seeded random, obviously fake); no real keys."""
import importlib.util, os, random, re
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location("secret_scan", os.path.join(REPO, "site", "scripts", "secret-scan.py"))
ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)
R = random.Random("FAKE-test-only")
B32 = "023456789acdefghjklmnpqrstuvwxyz"
FAKE_NSEC = "nsec1" + "".join(R.choice(B32) for _ in range(58))
FAKE_HEX = lambda: "".join(R.choice("0123456789abcdef") for _ in range(64))

GUARD_LINES = [  # the exact lines CI run 41268966989 flagged
    'if (/nsec1[02-9ac-hj-np-z]{20,}/.test(s) || (skHex && s.indexOf(skHex) !== -1)) throw new Error("refusing to send: event contains a secret key");',
    'if (state.skHex && s.indexOf(state.skHex) !== -1) throw new Error("refusing to send: the event contains the secret key");',
    'if (!m) throw new Error("expected nostr+walletconnect://<64-hex>?relay=...&secret=...");',
    'if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error("NWC secret missing");',
    'account_id = "REPLACE_AT_DEPLOY"',
]

def test_guard_code_passes():
    assert ss.scan_text("x.js", "\n".join(GUARD_LINES)) == []

def test_fake_nsec_caught():
    assert ss.scan_text("x.js", f'const k = "{FAKE_NSEC}";') == ["x.js:1: nsec-bech32"]

def test_fake_nwc_secret_caught():
    uri = f"nostr+walletconnect://{FAKE_HEX()}?relay=wss://relay.example&secret={FAKE_HEX()}"
    assert "nwc-uri-secret" in ss.scan_text("README.md", f"use {uri}")[0]

def test_fake_hex_key_assignment_caught():
    for line in (f'skHex = "{FAKE_HEX()}"', f'"secret": "{FAKE_HEX()}"', f"FACILITATOR_SK_HEX={FAKE_HEX()}"):
        assert ss.scan_text("f", line), line

def test_fake_api_token_caught_and_output_redacted(tmp_path, capsys):
    tok = "".join(R.choice("ABCDEFabcdef0123456789") for _ in range(40))
    p = tmp_path / "wrangler.toml"; p.write_text(f'api_token = "{tok}"\n')
    assert ss.main([str(p)]) == 1
    out = capsys.readouterr().out
    assert "api-token-assignment" in out and tok not in out

def test_per_line_allow_marker():
    assert ss.scan_text("x", f'"{FAKE_NSEC}" // secret-scan: allow (doc example)') == []

def test_workflow_uses_value_scan_not_word_grep():
    wf = open(os.path.join(REPO, ".github", "workflows", "site.yml")).read()
    step = wf[wf.index("- name: Secret scan"):]
    assert "python3 scripts/secret-scan.py" in step
    assert not re.search(r'git grep -nE "\(api\[_-\]\?token\|account_id\|secret\)"', step)
