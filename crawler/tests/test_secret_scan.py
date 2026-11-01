"""Repo secret scan (site/scripts/secret-scan.py): guard code passes, real-looking FAKE secrets are caught.
All test values are generated here at runtime (seeded random / string concatenation, obviously fake); no real keys,
and no literal in this file is itself a secret-looking value."""
import importlib.util, os, random, re, subprocess, sys
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(REPO, "site", "scripts", "secret-scan.py")
spec = importlib.util.spec_from_file_location("secret_scan", SCRIPT)
ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)
R = random.Random("FAKE-test-only")
B32 = "023456789acdefghjklmnpqrstuvwxyz"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
FAKE_NSEC = "ns" + "ec1" + "".join(R.choice(B32) for _ in range(58))
hexs = lambda n: "".join(R.choice("0123456789abcdef") for _ in range(n))
FAKE_HEX = lambda: hexs(64)
EQ = "="  # keeps `name = value` pairs from forming in this file's source
MARK = "secret-scan: " + "allow"

def rules(line, name="f"):
    return [h.split(": ", 1)[1] for h in ss.scan_text(name, line)]

GUARD_LINES = [  # the exact lines CI run 41268966989 flagged
    'if (/nsec1[02-9ac-hj-np-z]{20,}/.test(s) || (skHex && s.indexOf(skHex) !== -1)) throw new Error("refusing to send: event contains a secret key");',
    'if (state.skHex && s.indexOf(state.skHex) !== -1) throw new Error("refusing to send: the event contains the secret key");',
    'if (!m) throw new Error("expected nostr+walletconnect://<64-hex>?relay=...&secret=...");',
    'if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error("NWC secret missing");',
    'account_id = "REPLACE_AT_DEPLOY"',
    'api_token = "REPLACE_AT_DEPLOY"  # set in CI',
    'const secret = env.NOSTR_SECRET;',
    'password: process.env.PASSWORD,',
]

def test_guard_code_passes():
    assert ss.scan_text("x.js", "\n".join(GUARD_LINES)) == []

def test_public_hex_contexts_pass():
    for line in (f'{{"id":"{FAKE_HEX()}","pubkey":"{FAKE_HEX()}"}}', f'SITE_ZAP_PUBKEY {EQ} "{FAKE_HEX()}"',
                 f'expect(r.payment_hash).toBe("{FAKE_HEX()}")'):
        assert rules(line) == [], line

def test_fake_nsec_caught():
    assert ss.scan_text("x.js", f'const k = "{FAKE_NSEC}";') == ["x.js:1: nsec-bech32"]

def test_p1_5_uppercase_nsec_caught():
    assert "nsec-bech32" in rules(f'k {EQ} "{FAKE_NSEC.upper()}"')

def test_fake_nwc_secret_caught():
    uri = f"nostr+walletconnect://{FAKE_HEX()}?relay=wss://relay.example&secret={FAKE_HEX()}"
    assert "nwc-uri-secret" in ss.scan_text("README.md", f"use {uri}")[0]

def test_fake_hex_key_assignment_caught():
    for line in (f'skHex {EQ} "{FAKE_HEX()}"', f'"secret": "{FAKE_HEX()}"', f"FACILITATOR_SK_HEX{EQ}{FAKE_HEX()}"):
        assert ss.scan_text("f", line), line

def test_p1_1_underscore_prefixed_names_caught():
    tok = "".join(R.choice(B58) for _ in range(40))
    for line, rule in ((f"CLOUDFLARE_API_TOKEN{EQ}{tok}", "api-token-assignment"),
                       (f"MY_API_TOKEN{EQ}{FAKE_HEX()}", "hex-key-assignment"),
                       (f"CLOUDFLARE_ACCOUNT_ID{EQ}{hexs(32)}", "account-id"),
                       (f'secret_key {EQ} "{FAKE_HEX()}"', "hex-key-assignment")):
        assert rule in rules(line), line

def test_p1_2_generic_key_names_0x_and_bare_hex_caught():
    for line in (f"key{EQ}{FAKE_HEX()}", f"nostr_key{EQ}{FAKE_HEX()}", f"seed: {FAKE_HEX()}", f"secret {EQ} 0x{FAKE_HEX()}"):
        assert "hex-key-assignment" in rules(line), line
    assert "quoted-hex64" in rules(f'const x {EQ} "{FAKE_HEX()}"')
    assert "quoted-hex64" in rules(f"const x {EQ} '0x{FAKE_HEX()}'")

def test_p1_3_pem_xprv_mnemonic_macaroon_base64_cf_key_caught():
    b64 = lambda n: "".join(R.choice(B58 + "+/") for _ in range(n))
    words = " ".join(R.choice(["abandon", "ability", "able", "about", "above", "absent", "zoo", "wrist"]) for _ in range(12))
    cases = {
        "pem-private-key": "-----BEGIN " + "EC PRIVATE KEY-----",
        "bip32-xprv": "xp" + "rv" + "".join(R.choice(B58) for _ in range(107)),
        "bip39-mnemonic": f'MNEMONIC {EQ} "{words}"',
        "lnd-macaroon": "0201036c" + "6e64" + hexs(80),
        "secret-literal-assignment": f"secret: {b64(44)}",
        "api-token-assignment": f"CF_API_KEY{EQ}{hexs(37)}",
    }
    for rule, line in cases.items():
        assert rule in rules(line), rule
    assert "lnd-macaroon" in rules("AgED" + "bG5k" + b64(60))
    for pem in ("-----BEGIN " + "PRIVATE KEY-----", "-----BEGIN " + "OPENSSH PRIVATE KEY-----", "-----BEGIN " + "RSA PRIVATE KEY-----"):
        assert "pem-private-key" in rules(pem)

def _git_repo(tmp_path, files):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    for name, body in files.items():
        p = tmp_path / name; p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(body) if isinstance(body, bytes) else p.write_text(body)
    subprocess.run(["git", "-C", str(tmp_path), "add", "-A"], check=True)

def test_p1_4_scans_whole_repo_from_any_cwd(tmp_path, monkeypatch, capsys):
    _git_repo(tmp_path, {"crawler/x.py": f'sk {EQ} "{FAKE_HEX()}"\n', "site/ok.txt": "fine\n", "root.env": f"nsec{EQ}{FAKE_NSEC}\n"})
    monkeypatch.chdir(tmp_path / "site")
    assert ss.main([]) == 1
    out = capsys.readouterr().out
    assert "crawler/x.py:1: hex-key-assignment" in out and "root.env:1: nsec-bech32" in out

def test_p1_4_and_p1_6_ci_scans_repo_without_paths_filter_and_gitleaks_blocks():
    wf = open(os.path.join(REPO, ".github", "workflows", "secret-scan.yml")).read()
    on = wf[wf.index("on:"):wf.index("jobs:")]
    assert "paths" not in on and "push" in on
    assert "python3 site/scripts/secret-scan.py" in wf and "working-directory" not in wf
    assert "gitleaks" in wf and "--no-git" not in wf and "set +e" not in wf and "|| true" not in wf
    assert "fetch-depth: 0" in wf
    assert os.path.exists(os.path.join(REPO, ".gitleaksignore")) and os.path.exists(os.path.join(REPO, ".gitleaks.toml"))

def test_fake_api_token_caught_and_output_redacted(tmp_path, capsys):
    tok = "".join(R.choice("ABCDEFabcdef0123456789") for _ in range(40))
    p = tmp_path / "wrangler.toml"; p.write_text(f'api_token {EQ} "{tok}"\n')
    assert ss.main([str(p)]) == 1
    out = capsys.readouterr().out
    assert "api-token-assignment" in out and tok not in out

def test_per_line_allow_marker():
    assert ss.scan_text("x", f'"{FAKE_NSEC}" // {MARK} (doc example)') == []

def test_p2_1_allow_marker_printed_and_counted_against_baseline(tmp_path, capsys):
    p = tmp_path / "a.txt"; p.write_text(f'k {EQ} "{FAKE_NSEC}" # {MARK}\n')
    assert ss.main([str(p)], baseline=1) == 0
    out = capsys.readouterr().out
    assert f"ALLOWED {p}:1: nsec-bech32" in out and FAKE_NSEC not in out
    assert ss.main([str(p)], baseline=0) == 1
    assert "allow-marker count 1 > baseline 0" in capsys.readouterr().out

def test_p2_1_committed_baseline_matches_real_tree():
    r = subprocess.run([sys.executable, SCRIPT], cwd=REPO, capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, [l for l in r.stdout.splitlines() if l.startswith("FAIL")]
    n = sum(l.startswith("ALLOWED ") for l in r.stdout.splitlines())
    assert n == int(open(os.path.join(REPO, ".secret-scan-allow-baseline")).read().split()[0])

def test_p2_2_split_and_multiline_values_caught():
    a, b = hexs(20), hexs(20)  # each half too short alone
    assert rules(f'sk {EQ} "{a}" +\n  "{b}"') == ["hex-key-assignment-multiline"]
    assert "hex-key-assignment-multiline" in rules(f'nsec {EQ} """\n{FAKE_HEX()}"""')
    assert "hex-key-assignment-multiline" in rules(f"secret {EQ}\n  {FAKE_HEX()}")

def test_p2_3_short_secrets_and_short_account_id_caught():
    assert "secret-literal-assignment" in rules(f'secret {EQ} "short-pw-123"')
    assert "secret-literal-assignment" in rules(f"DB_PASSWORD{EQ}hunter2hunter")
    assert "account-id" in rules(f'account_id {EQ} "abc123"')
    assert "account-id" in rules(f'account_id {EQ} "{hexs(31)}"')

def test_p2_4_replace_at_deploy_must_be_bare():
    assert rules(f'api_token {EQ} "REPLACE_AT_DEPLOY"') == []
    assert "api-token-assignment" in rules(f'api_token {EQ} "REPLACE_AT_DEPLOY{hexs(40)}"')
    assert "account-id" in rules(f'account_id {EQ} "REPLACE_AT_DEPLOY{hexs(32)}"')

def test_p2_5_utf16_decoded_and_binary_skip_printed(tmp_path, capsys):
    u = tmp_path / "u16.txt"; u.write_bytes(f'sk {EQ} "{FAKE_HEX()}"\n'.encode("utf-16"))
    b = tmp_path / "bin.dat"; b.write_bytes(b"\0\1\2" + f"nsec{EQ}{FAKE_NSEC}".encode())
    assert ss.main([str(u), str(b)]) == 1
    out = capsys.readouterr().out
    assert f"{u}:1: hex-key-assignment" in out and f"SKIP {b}: binary" in out

def test_p2_6_missing_path_exits_nonzero(tmp_path, capsys):
    assert ss.main([str(tmp_path / "nonexist.txt")]) == 2
    assert "no such file" in capsys.readouterr().out

def test_p2_7_fixture_exclusion_is_exact(tmp_path, monkeypatch, capsys):
    _git_repo(tmp_path, {"site/worker/src/fixture-data.ts": f'k {EQ} "{FAKE_NSEC}"\n',
                         "site/worker/src/fixture-data.ts.bak": f'k {EQ} "{FAKE_NSEC}"\n'})
    monkeypatch.chdir(tmp_path)
    assert ss.main([]) == 1
    out = capsys.readouterr().out
    assert "fixture-data.ts.bak:1: nsec-bech32" in out and "fixture-data.ts:1:" not in out

def test_workflow_uses_value_scan_not_word_grep():
    wf = open(os.path.join(REPO, ".github", "workflows", "secret-scan.yml")).read()
    assert "python3 site/scripts/secret-scan.py" in wf
    assert not re.search(r'git grep -nE "\(api\[_-\]\?token\|account_id\|secret\)"', wf)
