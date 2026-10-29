"""Offline Playwright test of the DOM UGC marker (page.set_content, no network)."""
import os, sys, unittest
HERE = os.path.dirname(__file__); sys.path.insert(0, os.path.dirname(HERE))
import crawl
from extract import extract_payments

class DomUGC(unittest.TestCase):
    def test_review_blocks_marked_and_ignored(self):
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            b = pw.chromium.launch(headless=True); p = b.new_page()
            p.set_content(open(os.path.join(HERE, "fixtures", "ugc_dom.html")).read())
            p.evaluate(crawl.MARK_JS); text = p.inner_text("body"); b.close()
        self.assertIn("[ugc-start]", text)
        pay, no, q = extract_payments([("https://shop.example/", "home", "Shop", text)])
        self.assertIn("btc", pay); self.assertIn("ln", pay)
        self.assertNotIn("pp", pay); self.assertNotIn("xmr", pay)
        self.assertIn("apay", pay)   # class 'preview-banner' must not be treated as a review block

    def test_ua_points_to_bot_page(self):
        self.assertIn("+https://klickymart.com/bot", crawl.UA)

if __name__ == "__main__": unittest.main()
