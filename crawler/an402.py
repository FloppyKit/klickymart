"""Shared helpers for building r['an_402'] in build_agent_native*.py."""


def slim_l402(v4):
    """Slim pass-through of verify_402's `l402` dict: only scheme, invoice, truncated (macaroon/raw dropped). None if absent."""
    l = (v4 or {}).get("l402")
    if not isinstance(l, dict): return None
    return {k: l.get(k) for k in ("scheme", "invoice", "truncated")}
