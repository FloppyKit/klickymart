import os, sys, unittest
HERE = os.path.dirname(__file__); sys.path.insert(0, os.path.dirname(HERE))
import kinds
from nostr_tags import tags_for, tags_match_content, validate_domain, tos_value

BASE = {"d": "example-store.com", "cat": ["elec"], "v": "0.3-draft", "ts": 1793291247,
        "ua": "ExampleMapBot/0.2 (+https://example.org/bot; bot@example.org)",
        "vantage": {"ip": "single-datacenter"}, "status": "crawled", "tos": "ok", "name": "Example Store",
        "ag": 3, "co": 2, "guest": True, "kyc": "none-stated", "btc": 3, "btc_any": True, "btc_priv": ["noacct"],
        "pay": ["card", "pp", "btc", "ln", "fedi"], "pay_online": ["ln", "btc"], "pay_instore": ["card"],
        "pay_unscoped": ["pp"], "pay_no": ["xmr"], "ar": [{"c": "cap"}, {"c": "cap"}, {"c": "rb_ck"}], "anw": None}

def labels(t): return {x[1] for x in t if x[0] == "l"}

class Tags(unittest.TestCase):
    def test_required(self):
        t = tags_for(BASE); keys = {x[0] for x in t}
        for k in ("d", "r", "L", "t", "crawled_at", "v", "license"): self.assertIn(k, keys)
        self.assertIn(["t", "shopping"], t); self.assertIn(["license", "CC0-1.0"], t)
        self.assertIn(["crawler", "ExampleMapBot/0.2", "https://example.org/bot"], t)
        self.assertTrue(all(x[2] == kinds.NS for x in t if x[0] == "l"))

    def test_readable_pay_names(self):
        L = labels(tags_for(BASE))
        for v in ("pay:card", "pay:paypal", "pay:btc-onchain", "pay:lightning", "pay:fedimint",
                  "pay_online:lightning", "pay_instore:card", "pay_unscoped:paypal", "no:monero"):
            self.assertIn(v, L)
        self.assertFalse({"pay:pp", "pay:ln", "pay:btc"} & L)
        self.assertEqual(kinds.pay_tag("bnpl:klarna"), "bnpl:klarna"); self.assertEqual(kinds.pay_tag("oth:x"), "other:x")

    def test_value_format_and_dedupe(self):
        t = tags_for(BASE); L = labels(t)
        for v in ("ag:3", "co:2", "btc:3", "btc_any", "btcpriv:noacct", "guest:yes", "kyc:none-stated", "ar:cap", "ar:rb_ck"):
            self.assertIn(v, L)
        self.assertEqual(sum(1 for x in t if x[1] == "ar:cap"), 1)

    def test_no_placeholders(self):
        r = dict(BASE, ag=None, co=None, btc=None, btc_any=False, guest=None, kyc=None, name=None, btc_priv=[])
        L = labels(tags_for(r))
        self.assertFalse(any(x.startswith(("ag:", "co:", "btc:", "guest:", "kyc:")) or x == "btc_any" for x in L))
        for x in tags_for(r):
            self.assertFalse(any(s in ("None", "null", "", "TO-CONFIRM") for s in x[1:2]), x)

    def test_tos_unknown_mapping(self):
        for raw in (None, "TO-CONFIRM", "weird"): self.assertEqual(tos_value(raw), "unknown")
        self.assertIn("tos:unknown", labels(tags_for(dict(BASE, tos="TO-CONFIRM"))))
        self.assertIn("tos:bans-automation", labels(tags_for(dict(BASE, tos="bans-automation"))))

    def test_blocked_tos_bare(self):
        r = {"d": "bigshop.example", "v": "0.3-draft", "ts": 1, "status": "blocked-tos", "tos": "bans-automation",
             "name": "Big", "pay": ["card"], "ar": [{"c": "tos"}]}
        L = labels(tags_for(r))
        self.assertEqual(L, {"status:blocked-tos", "tos:bans-automation"})

    def test_anw(self):
        r = dict(BASE, status="agents-not-welcome", anw={"type": "http-403"})
        self.assertIn("anw:http-403", labels(tags_for(r)))

    def test_error_cause(self):
        r = dict(BASE, status="error", anw={"type": "robots-unreachable", "cause": "timeout"})
        L = labels(tags_for(r)); self.assertIn("anw:robots-unreachable", L); self.assertIn("cause:timeout", L)
        self.assertNotIn("cause:bogus", labels(tags_for(dict(r, anw={"type": "robots-unreachable", "cause": "bogus"}))))

    def test_canonical_domain(self):
        self.assertEqual(validate_domain("shop.example.org"), "shop.example.org")
        self.assertEqual(validate_domain("xn--bcher-kva.example"), "xn--bcher-kva.example")
        for bad in ("Example.com", "www.example.com", "https://example.com", "example.com/x", "example.com:443",
                    "bücher.example", "example", "", " example.com", "-a.example"):
            with self.assertRaises(ValueError, msg=bad): validate_domain(bad)
        with self.assertRaises(ValueError): tags_for(dict(BASE, d="www.example-store.com"))

    def test_requires_v_ts_status(self):
        for k in ("v", "ts"):
            r = dict(BASE); r.pop(k)
            with self.assertRaises(ValueError): tags_for(r)
        with self.assertRaises(ValueError): tags_for(dict(BASE, status="maybe"))
        with self.assertRaises(ValueError): tags_for(dict(BASE, btc_priv=["custodial"]))

    def test_tags_match_content(self):
        t = tags_for(BASE)
        self.assertTrue(tags_match_content(list(reversed(t)), BASE))
        self.assertFalse(tags_match_content(t + [["l", "pay:monero", kinds.NS]], BASE))
        self.assertFalse(tags_match_content(t, dict(BASE, ag=1)))

class Constants(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual((kinds.KIND_SITE, kinds.KIND_NEED, kinds.KIND_FULFILL, kinds.KIND_ACCEPT), (31420, 420, 421, 422))
        self.assertTrue(30000 <= kinds.KIND_SITE < 40000)
    def test_sign_events_uses_constant(self):
        src = open(os.path.join(os.path.dirname(HERE), "sign_events.py")).read()
        self.assertNotIn("31420", src)

if __name__ == "__main__": unittest.main()


def test_v3_tags_sub_policy_ship():
    from nostr_tags import tags_for
    r = {"d": "example.com", "v": "0.4-draft", "ts": 1, "status": "crawled", "sub": ["audio"],
         "agent_policy": {"v": "restricts-agents"}, "ship": {"pre_pay": True, "ships_us": None}}
    t = tags_for(r)
    assert ["l", "sub:audio", "nip-xx"] in t and ["l", "agentpolicy:restricts-agents", "nip-xx"] in t
    assert ["l", "shippre:yes", "nip-xx"] in t and not any(x[1].startswith("shipsus") for x in t if x[0] == "l")
