import os, sys, unittest
HERE = os.path.dirname(__file__); sys.path.insert(0, os.path.dirname(HERE))
from tos import classify
import crawl

class Tos(unittest.TestCase):
    def test_ban(self):
        t = "Welcome. You agree not to use any robot, spider, scraper or other automated means to access the Site. Enjoy."
        c, q, _ = classify(t); self.assertEqual(c, "bans-automation"); self.assertIn("robot, spider", q); self.assertIn(q, t)
    def test_ban_reverse_order(self):
        c, q, _ = classify("Use of data mining, robots, or similar data gathering tools is prohibited.")
        self.assertEqual(c, "bans-automation")
    def test_definition_is_not_a_ban(self):
        s = 'In this section, "Agent" means any software, artificial intelligence system, bot, automated tool, or programmatic client that interacts with the Store on behalf of a user.'
        self.assertEqual(classify(s), ("ok", None, None))
    def test_list_clause_under_lead(self):
        t = "You agree not to: (a) copy the site; (b) resell products; (f) except for manually operated web-browsers, use any robot, spider, script or other automated means to access any portion of the website; (g) frame the site."
        c, q, lead = classify(t)
        self.assertEqual(c, "bans-automation"); self.assertIn("robot, spider", q); self.assertIn("agree not to", lead)
        self.assertIn(q, t); self.assertIn(lead, t)
    def test_agentic_tools(self):
        t = "All other Agentic Commerce Tools are unauthorized, expressly prohibited, and may not be used to access, log into, scrape, query, or otherwise interact with the Site."
        self.assertEqual(classify(t)[0], "bans-automation")
    def test_indemnify_agents_is_not_ban(self):
        self.assertEqual(classify("You will indemnify us and our officers, agents and licensors from all claims.")[0], "ok")
    def test_ok(self):
        self.assertEqual(classify("We accept returns within 30 days. Prices may change without notice."), ("ok", None, None))
    def test_blocked_record_skips_crawl(self):
        t = {"d": "x.example", "tos": "bans-automation", "q": "You may not use bots.", "url": "https://x.example/terms"}
        r = crawl.crawl_site(None, {"d": "x.example"}, "/tmp", t)   # browser=None: must not be touched
        self.assertEqual(r["status"], "blocked-tos"); self.assertEqual(r["ar"][0]["c"], "tos")
        self.assertEqual(r["tos_url"], t["url"]); self.assertEqual(r["tos_q"], t["q"]); self.assertIsNone(r["pay_online"] or None)

if __name__ == "__main__": unittest.main()
