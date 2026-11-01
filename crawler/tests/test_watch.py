"""D8 test vectors: a throwaway key generated in-test (never the crawler key); in-memory relay."""
import json, os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from watch import WatchServer, parse_watch, MAX_WATCHES_PER_KEY
try:
    from nostr_sdk import Keys, EventBuilder, Kind, Tag
except Exception: Keys = None
NOW = 1_800_000_000
def signer(keys):
    def sign(ev):
        e = EventBuilder(Kind(ev["kind"]), ev["content"]).tags([Tag.parse(t) for t in ev["tags"]]).finalize_unsigned(keys.public_key()).sign(keys)
        return json.loads(e.as_json())
    return sign
@unittest.skipIf(Keys is None, "nostr_sdk not installed")
class T(unittest.TestCase):
    def setUp(self):
        self.shopper, self.server_key = Keys.generate(), Keys.generate()
        self.relay = []
        self.prices = {"price": 249.0, "stock": "in"}
        def recheck(dom, gtin): return {"domain": dom, "price": self.prices["price"], "cur": "USD", "stock": self.prices["stock"], "url": f"https://{dom}/p/{gtin}"}
        self.calls = 0
        def counted(d, g): self.calls += 1; return recheck(d, g)
        self.srv = WatchServer(recheck=counted, sign=signer(self.server_key), publish=self.relay.append)
    def need(self, price="199.00", exp=NOW + 3600, key=None):
        return signer(key or self.shopper)({"kind": 420, "created_at": NOW, "content": "", "tags": [["t", "watch"], ["l", "gtin:0840268906138", "nip-xx"], ["r", "example.com"], ["cond", "price<", price, "USD"], ["expiration", str(exp)]]})
    def test_vector_parse(self):
        w, why = parse_watch(self.need(), NOW); self.assertIsNotNone(w); self.assertEqual(w.price_lt, 199.0)
        self.assertEqual(parse_watch(self.need(exp=NOW - 1), NOW)[1], "missing or past expiration")
    def test_price_drop_emits_31421_and_421(self):
        self.assertTrue(self.srv.add(self.need(), NOW)[0])
        out = self.srv.tick(NOW); self.assertEqual([e["kind"] for e in out], [31421])          # 249 >= 199: offer only
        self.prices["price"] = 189.0
        self.assertEqual(self.srv.tick(NOW + 300), [])                                          # coalesced: < 10 min
        out = self.srv.tick(NOW + 601)
        self.assertEqual([e["kind"] for e in out], [31421, 421])
        f = out[1]; self.assertIn(["proof", "event", out[0]["id"]], f["tags"]); self.assertEqual(len(self.relay), 3)
    def test_coalesced_across_watchers_and_limits(self):
        for _ in range(3): self.srv.add(self.need(key=Keys.generate()), NOW)
        self.srv.tick(NOW); self.assertEqual(self.calls, 1)
        k = Keys.generate()
        for i in range(MAX_WATCHES_PER_KEY): self.assertTrue(self.srv.add(self.need(price=str(100 + i), key=k), NOW)[0])
        self.assertEqual(self.srv.add(self.need(key=k), NOW)[1], "too many active watches for this key")
if __name__ == "__main__": unittest.main()
