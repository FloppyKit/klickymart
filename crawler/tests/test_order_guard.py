import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from order_guard import is_denied
class T(unittest.TestCase):
    def test_blocks_place_order_posts(self):
        for u in ["https://shop.example/checkout/placeOrder", "https://x.com/api/orders/create", "https://api.stripe.com/v1/payment_intents/pi_1/confirm",
                  "https://x.com/checkout/complete", "https://x.com/api/submit-order", "https://x.com/payments/authorize"]:
            self.assertTrue(is_denied("POST", u), u)
    def test_allows_gets_and_cart(self):
        self.assertFalse(is_denied("GET", "https://x.com/checkout/placeOrder"))
        self.assertFalse(is_denied("POST", "https://x.com/cart/add.js"))
        self.assertFalse(is_denied("POST", "https://x.com/checkouts/abc/contact_information"))
if __name__ == "__main__": unittest.main()
