import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from terms_page import is_terms_page

LEGAL = ("By using this site you agree to these Terms. This agreement is governed by the laws of Illinois. "
         "Our liability is limited; we disclaim all warranties. Disputes go to binding arbitration. "
         "You agree to indemnify us. Intellectual property remains ours. We may terminate access. ") * 6
PICKER = "Choose your country or region\nAmericas\nUnited States (English)\nCanada (English)\n" * 40

class TermsPageTest(unittest.TestCase):
    def test_region_picker_rejected(self):
        ok, _ = is_terms_page("https://www.baratza.com/choose-location", "Choose Location", "Choose your country or region", PICKER)
        self.assertFalse(ok)
    def test_named_but_not_legal_rejected(self):
        ok, why = is_terms_page("https://x.com/pages/terms", "Terms", "Terms", PICKER)
        self.assertFalse(ok); self.assertIn("legal", why)
    def test_legal_text_without_name_rejected(self):
        ok, _ = is_terms_page("https://x.com/about", "About us", "About", LEGAL)
        self.assertFalse(ok)
    def test_real_terms_page_accepted(self):
        self.assertTrue(is_terms_page("https://x.com/policies/terms-of-service", "Terms of service", "", LEGAL)[0])
        self.assertTrue(is_terms_page("https://x.com/legal", "Legal", "Terms & Conditions of Use", LEGAL)[0])
    def test_short_page_rejected(self):
        self.assertFalse(is_terms_page("https://x.com/terms", "Terms", "", LEGAL[:500])[0])

if __name__ == "__main__": unittest.main()
