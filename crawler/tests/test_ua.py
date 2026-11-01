import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import ua, crawl
class T(unittest.TestCase):
    def test_agent_token(self):
        self.assertIn("Agent/KlickyBot", ua.UA); self.assertEqual(crawl.UA, ua.UA)
        self.assertTrue(ua.UA.startswith(ua.UA_TOKEN + "/"))
if __name__ == "__main__": unittest.main()
