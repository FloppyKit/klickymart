from pay_quote_check import supports
def test_bitrefill_bad_quotes():
    assert not supports("gift", "However, we know some users want to use other coins to purchase gift cards and recharge their phones, so we have integrated Li.Fi Pay")
    assert not supports("card", "Popular in United StatesDigital Prepaid VisaAmazon.comDoorDashAppleUber EatsVirtual Prepaid Mastercard")
def test_good_quotes():
    assert supports("card", "We accept Visa, Mastercard and American Express.")
    assert supports("gift", "You can redeem a gift card at checkout.")
    assert supports("ln", "Pay with Bitcoin Lightning at checkout")
    assert supports("pp", "Payment methods: PayPal")
def test_more():
    assert supports("gift", "BestBuy.com accepts these payment types: ... Best Buy Gift Cards")
    assert supports("btc", "Buy Gift Cards With Bitcoin.")
    assert not supports("gift", "Buy Gift Cards With Bitcoin.")
    assert supports("card", "Credit card sales are processed through Shopify, which we do not like")
    assert not supports("card", "Discover")
