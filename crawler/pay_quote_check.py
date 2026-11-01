"""Does a pay quote actually say the store accepts that payment method? (round-1 item 5)
A quote supports code c only if it names the method AND has payment context, and is not about buying that thing
(e.g. a gift-card shop listing 'Visa' or 'Mastercard' gift cards for sale)."""
import re
KW = {
    "card": r"\b(visa|master ?card|amex|american express|discover|credit|debit|card payments?)\b",
    "gift": r"\bgift ?cards?\b|\bstore credit\b|\bgift certificates?\b",
    "pp": r"\bpay ?pal\b", "apay": r"\bapple ?pay\b", "gpay": r"\bgoogle ?pay\b", "spay": r"\bshop ?pay\b",
    "bnpl:afterpay": r"\bafterpay\b|\bclearpay\b", "bnpl:klarna": r"\bklarna\b", "bnpl:affirm": r"\baffirm\b", "bnpl:zip": r"\bzip\b|\bquadpay\b", "bnpl:sezzle": r"\bsezzle\b",
    "crypto": r"\bcrypto(currenc(y|ies))?\b", "eth": r"\beth(ereum)?\b", "usdc": r"\busdc\b", "usdt": r"\busdt\b|\btether\b", "ltc": r"\blitecoin\b|\bltc\b",
    "ach": r"\bach\b|\bbank transfer\b|\bwire\b", "hsa": r"\bhsa\b|\bfsa\b", "cashapp": r"\bcash ?app\b", "zelle": r"\bzelle\b", "oth:lease": r"\bleas(e|ing)\b",
    "btc": r"\bbitcoin\b|\bbtc\b|on-?chain", "ln": r"\blightning\b|\blnurl\b|\bbolt ?1[12]\b", "cashu": r"\bcashu\b|\becash\b",
}
PAYCTX = r"(?i)\b(pay|pay-later|processed|installments|paying|payment|payments|accept|accepted|accepts|checkout|check out|redeem|use|using|method|tender|we take|apply)\b"
# Gift cards: payment context must be next to the gift-card words, not anywhere in the sentence.
GIFT_PAY = r"(?i)(pay|paying|payment|redeem|use|apply|accept\w*)\W+(\w+\W+){0,6}gift ?(cards?|certificates?)|gift ?(cards?|certificates?)\W+(\w+\W+){0,6}(as (a )?(form of )?payment|balance|at checkout|can be (used|redeemed|applied))"
# Card brands listed as products for sale (prepaid Visa, Mastercard gift card) are not card acceptance.
CARD_SOLD = r"(?i)(prepaid|virtual) (visa|master ?card)|(visa|master ?card) (gift|prepaid)"

def supports(code: str, quote: str) -> bool:
    q = quote or ""
    if code == "btc" and re.search(r"(?i)btcpay", q): return True
    if code in ("usdc", "usdt", "eth", "ltc") and re.search(KW[code], q[:24], re.I): return True
    kw = KW.get(code)
    if not kw or not re.search(kw, q, re.I): return False
    if code in ("btc", "ln", "crypto", "eth", "usdc", "usdt", "ltc") and (re.search(r"(?i)\b(with|spend|using|via)\W+(\w+\W+){0,2}(bitcoin|btc|crypto|lightning)", q) or re.search(r"(?i)btcpay", q)): return True
    if code in ("usdc", "usdt", "eth", "ltc") and re.match(KW[code], q, re.I): return True  # coin row of a supported-coins table
    if len(q.split()) <= 5 and not re.search(r"(?i)\b(buy|get|discover|refund|approved)\b", q): return True  # a bare item of a payment-methods list
    if code == "gift":
        if re.search(r"(?i)accepts? (these )?payment", q): return True
        if re.search(r"(?i)\b(buy|purchase|purchasing|sell|order|send|give)\w*\W+(\w+\W+){0,3}gift ?cards?", q) and not re.search(r"(?i)(pay|redeem)\w*\W+(with|using)\W+(a |your )?gift ?card", q): return False
        return bool(re.search(GIFT_PAY, q))
    if code == "card" and re.search(CARD_SOLD, q) and not re.search(r"(?i)(pay|accept)\w*\W+(\w+\W+){0,4}(credit|debit|visa|master)", q): return False
    return bool(re.search(PAYCTX, q))
