"""KM-N01: never sign captured session/auth material into public records.
redact(obj) walks a record and, for every string:
  - http(s) URLs lose their fragment, userinfo and every query parameter except a small allowlist of navigational ones
    (variant, id, hl, lang, page, ...). Login redirects carry OAuth state/nonce and Shopify buyer_flags JWTs, and stores
    put session ids in URLs (homepage_session_id, _x_sessn_id, x5secdata, Shopify _r);
  - any remaining JWT-shaped token (eyJ...xxx.yyy) or long bearer-ish secret is replaced with "[redacted]".
Pure function, no I/O. Used by sign_events.py right before signing and by checkout_probe.py when it records steps."""
import re
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

JWT = re.compile(r"eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}")
SECRETISH = re.compile(r"\b(shp(?:at|ca|ss|pa|ua)_[0-9a-fA-F]{16,}|sk_(?:live|test)_[0-9A-Za-z]{16,}|ghp_[0-9A-Za-z]{20,}|xox[abp]-[0-9A-Za-z-]{10,}|AKIA[0-9A-Z]{16})\b")
URL = re.compile(r"https?://[^\s\"'<>]+", re.I)
REDACTED = "[redacted]"
KEEP_PARAMS = {"variant", "id", "hl", "lang", "language", "locale", "page", "protocol", "sort", "nav", "colour", "color", "sz", "size", "q"}
# Parameters that carry session, auth or anti-bot state. A record holding one is "affected" (needs re-signing), not just tidied.
# Shopify (and similar) put the anonymous cart/checkout session token in the path: /checkouts/cn/<token>/...
CHECKOUT_PATH = re.compile(r"(?i)(/(?:checkouts|checkout|cart)/(?:cn|c|ac|co)/)([A-Za-z0-9_-]{16,})")
TOKEN_PARAM = re.compile(r"(?i)(token|session|sessn|sess_?id|^state$|nonce|^code$|auth|jwt|secret|sig(nature)?$|ticket|x5sec|^_r$|buyer_flags|redirect_uri|password|apikey|api_key)")


def clean_url(u: str) -> str:
    try:
        p = urlsplit(u)
    except ValueError:
        return REDACTED
    if p.scheme.lower() not in ("http", "https") or not p.netloc:
        return u
    netloc = p.netloc.rsplit("@", 1)[-1]  # drop user:pass@
    kept = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
            if k.lower() in KEEP_PARAMS and not JWT.search(v) and len(v) <= 64]
    path = CHECKOUT_PATH.sub(lambda m: m.group(1) + REDACTED, p.path)
    return urlunsplit((p.scheme, netloc, path, urlencode(kept), ""))


def redact_str(s: str) -> str:
    s = URL.sub(lambda m: clean_url(m.group(0)), s)
    s = JWT.sub(REDACTED, s)
    return SECRETISH.sub(REDACTED, s)


def redact(obj):
    if isinstance(obj, str):
        return redact_str(obj)
    if isinstance(obj, list):
        return [redact(x) for x in obj]
    if isinstance(obj, dict):
        return {k: redact(v) for k, v in obj.items()}
    return obj


def affected(obj) -> bool:
    """True when the record holds session/auth/token material (not just tracking params)."""
    return any(k != "tracking-param" for _, k, _ in findings(obj))


def findings(obj, path="$"):
    """List (json_path, kind, first4) for every value redact() would change; values are never returned in full."""
    out = []
    if isinstance(obj, dict):
        for k, v in obj.items(): out += findings(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj): out += findings(v, f"{path}[{i}]")
    elif isinstance(obj, str) and redact_str(obj) != obj:
        m = JWT.search(obj) or SECRETISH.search(obj)
        toks = [(k, v) for u in URL.findall(obj) for k, v in parse_qsl(urlsplit(u).query, keep_blank_values=True) if TOKEN_PARAM.search(k)]
        for u in URL.findall(obj):
            c = CHECKOUT_PATH.search(urlsplit(u).path)
            if c: out.append((path, "checkout-path-token", c.group(2)[:4]))
        if m: out.append((path, "jwt" if m.re is JWT else "secret", m.group(0)[:4]))
        for k, v in toks: out.append((path, f"token-param:{k}", v[:4]))
        if not m and not toks and not any(CHECKOUT_PATH.search(urlsplit(u).path) for u in URL.findall(obj)): out.append((path, "tracking-param", ""))
    return out
