"""Deterministic payment extraction from rendered text, line-based. Every hit carries a quote.
- Payment pages (url/title mentions payment/pay/accept/faq/refund): any matching line counts.
- Other pages: the line itself must contain a payment-context word and be >= 25 chars;
  menu-like lines ('Credit and Payment Cards') are ignored.
- Negations on the same line route to pay_no. Low-confidence hits are marked.
- UGC filter (v0.3-draft): customer reviews, Q&A, comments and testimonials are never payment
  evidence. Lines between [ugc-start]/[ugc-end] markers (inserted by crawl.py around review DOM
  blocks), lines under a review/Q&A heading, and review-shaped lines are skipped.
- Scope (v0.3-draft): every quote carries scope online / in-store / both / null (unstated)."""
import hashlib, os, re, unicodedata
from datetime import datetime, timezone
TERMS = [
 ("card", r"\b(visa|mastercard|american express|amex|discover|credit cards?|debit cards?)\b"),
 ("pp", r"\bpaypal\b(?!\W*pay in 4)"), ("bnpl:pp4", r"\bpaypal\W*pay in 4\b"),
 ("apay", r"\bapple pay\b"), ("gpay", r"\bgoogle pay\b"), ("spay", r"\bshop pay\b"),
 ("venmo", r"\bvenmo\b"), ("cashapp", r"\bcash app( pay)?\b"), ("zelle", r"\bzelle\b"),
 ("ebt", r"\bebt\b"), ("hsa", r"\b(hsa|fsa)\b"), ("gift", r"\bgift ?cards?\b"),
 ("bnpl:affirm", r"\baffirm\b"), ("bnpl:klarna", r"\bklarna\b"), ("bnpl:afterpay", r"\bafterpay\b"),
 ("bnpl:sezzle", r"\bsezzle\b"), ("bnpl:zip", r"\bzip\b(?=.{0,40}(pay|install))"),
 ("ach", r"\b(ach transfer|bank transfer|checking account)\b"),
 ("ln", r"\blightning\b"), ("btc", r"\bbitcoin\b|\bbtc\b|\bon-?chain\b"),
 ("liq", r"\bliquid\b(?=.{0,20}(network|bitcoin|btc|usdt|asset))|\blbtc\b"),
 ("cashu", r"\bcashu\b"), ("fedi", r"\bfedimint\b"), ("ark", r"\bark\b(?=.{0,20}(protocol|payment))"),
 ("sp", r"\bsilent payments?\b"), ("bolt12", r"\bbolt ?12\b"),
 ("usdt", r"\b(usdt|tether)\b"), ("usdc", r"\busdc\b"), ("eth", r"\bethereum\b"),
 ("ltc", r"\blitecoin\b"), ("xmr", r"\bmonero\b|\bxmr\b"), ("crypto", r"\bcrypto(currency|currencies)?\b"),
]
CTX = re.compile(r"(?i)\b(pay|paying|paid|payment|payments|checkout|accept|accepted|accepts|purchase|purchased|buy|method|methods|tender|refund(s|ed)?)\b")
PAYPAGE = re.compile(r"(?i)payment|pay|accept|faq|refund|checkout")
NAV = re.compile(r"(?i)^(credit (and|&) payment cards|payment cards|gift cards|shop .{0,20}|.{0,30} gift cards?)$")
NEG = re.compile(r"(?i)\b(not|no longer|don't|do not|cannot|can't|isn't|aren't|unable to)\b[^.]{0,60}\b(accept|use|pay|support|available)")
STRONG_BTC = re.compile(r"(?i)\b(pay|paying|paid|purchase|buy|checkout|accept\w*)\b.{0,60}\b(bitcoin|btc|lightning|on-?chain)\b|\b(bitcoin|btc|lightning|on-?chain)\b.{0,40}\b(payments?|accepted|checkout|invoice)\b")
UGC_HEAD = re.compile(r"(?i)^(customer |product |guest |user )?(reviews?|ratings?( (and|&) reviews?)?|testimonials?|comments?|questions? (and|&) answers?|q ?& ?a|community q&a|what (our )?customers (are )?say(ing)?|reviews? from .{0,30})\s*(\(\d[\d,]*\))?:?$")
UGC_LINE = re.compile(r"(?i)verified (purchase|buyer|owner)|\bout of 5 stars\b|[★☆]{2,}|^\d(\.\d)? ?(★|stars?)\b|\breviewed (in|on|by)\b|was this (review|answer) helpful|report (abuse|review)|\bhelpful \(\d+\)|^(q|a|question|answer)\s*:|\basked by\b|\banswered by\b|^\d[\d,]* (reviews?|ratings?|answers?|comments?)$")
FIRST_PERSON = re.compile(r"(?i)(^|[\s\"'(])(i|i'm|i've|i'd|i'll|my|me)\b")
REVIEW_COUNT = re.compile(r"(?i)^\d[\d,]* (reviews?|ratings?)$")
DATE_LINE = re.compile(r"(?i)^((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* \d{1,2},? \d{4}|(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* \d{4}|\d{1,2}/\d{1,2}/\d{2,4}|\d+ (days?|weeks?|months?|years?) ago)$")
HEADING_END = re.compile(r"^(##\s|\[collapsed\]$)")
UGC_WINDOW = 60   # lines after a review/Q&A heading treated as UGC unless a new '## ' heading or [ugc-end] appears
INSTORE = re.compile(r"(?i)\bin[- ]stores?\b|\bin[- ]store\b|\bat (the |our )?(register|store|counter|till)s?\b|\bstores? (may|will|can|have|accept)\b|\bstore team\b|\b(authorized|select|participating|retail|physical) (stores?|locations?)\b|\bcheckout registers?\b|\bcontactless\b|\bpoint of sale\b|\bpos terminals?\b")
ONLINE = re.compile(r"(?i)\bonline\b|\bon (our|the) (web ?site|site|app)\b|\bweb ?site\b|\bin[- ]app\b|\be-?gift ?cards?\b|\becommerce\b|\bonline checkout\b|\bdigital (orders?|checkout)\b")
SCOPE_HEAD_INSTORE = re.compile(r"(?i)^##\s.*\b(in[- ]stores?|in[- ]store|at (the )?store|stores?)\b")
SCOPE_HEAD_ONLINE = re.compile(r"(?i)^##\s.*\b(online|web ?site|in[- ]app)\b")

def line_scope(line, head_scope=None):
    """online / in-store / both from the line itself; falls back to the enclosing section heading; else None."""
    i, o = bool(INSTORE.search(line)), bool(ONLINE.search(line))
    if i and o: return "both"
    if i: return "in-store"
    if o: return "online"
    return head_scope

def ugc_mask(lines, paypage=False):
    """Return a list of booleans: True where the line is customer-generated content (review, Q&A, comment)."""
    mask = [False] * len(lines); depth = 0; window = 0
    for i, l in enumerate(lines):
        if l == "[ugc-start]": depth += 1; mask[i] = True; continue
        if l == "[ugc-end]": depth = max(0, depth - 1); mask[i] = True; window = 0; continue
        if depth: mask[i] = True; continue
        if HEADING_END.match(l) and not UGC_HEAD.match(l.lstrip("# ").strip()): window = 0
        if UGC_HEAD.match(l.lstrip("# ").strip()): window = UGC_WINDOW; mask[i] = True; continue
        if window: window -= 1; mask[i] = True; continue
        if UGC_LINE.search(l): mask[i] = True; continue
        # review card shape: text sandwiched by a date line above or an 'N reviews' line within 3 below
        near_date = i > 0 and DATE_LINE.match(lines[i-1] or "")
        near_count = any(REVIEW_COUNT.match(x) for x in lines[i+1:i+4])
        if (near_date or near_count) and len(l) >= 25: mask[i] = True; continue
        # first-person narrative is never merchant policy text (merchants say 'we'/'you')
        if not paypage and FIRST_PERSON.search(l) and len(l) >= 25: mask[i] = True
    return mask

BTC_STRICT = {"btc", "ln", "liq", "cashu", "fedi", "ark", "sp", "bolt12", "lnurl"}
_COIN = r"(bitcoin|btc|lightning|sats|cashu|ecash|on-?chain)"
ACCEPT_RX = re.compile(r"(?i)\b(pay|paying|paid for|checkout|check out|purchase|order|shop|buy\b[^.]{0,40}?)\b[^.]{0,40}\b(with|using|via|in)\s+(\w+\s+){0,2}" + _COIN + r"\b"
                       r"|\b" + _COIN + r"\b[^.]{0,30}\b(accepted|payments? (accepted|option|method)s?|checkout|invoice)\b"
                       r"|\b(we|now) accepts?\b[^.]{0,40}\b" + _COIN + r"\b|\baccepts?\b[^.]{0,20}\b" + _COIN + r"\b")
EDITORIAL_RX = re.compile(r"(?i)\b(buy|sell|trade|earn|invest|price of|interest|paid in|send|stack|hodl|learn|news|protocol|network is)\b[^.]{0,12}\b(and sell\s+)?" + _COIN + r"\b")
NOT_PAYMENT_RX = re.compile(r"(?i)bitcoin-backed|line of credit|\bloans?\b|\binterest\b|\bdoes [\w.]+ accept\b|\bwhere (can|to) (i )?(spend|use)\b")
BADGE_RX = re.compile(r"(?i)^(" + _COIN + r"( (and|or|&) " + _COIN + r")?( network)? (accepted|payments? accepted)( here)?|pay with " + _COIN + r")[.!]?$")

# On a payment page, a short table/list row naming a coin or network ("Bitcoin BTC Bitcoin Network, Lightning Network")
# is a list of accepted methods even without a verb (bitrefill help center, 2026-10-30 QA).
LIST_ROW_RX = re.compile(r"(?i)\b(lightning|bitcoin|liquid) network\b|\bbitcoin\s+\(?btc\)?\s+\S")   # needs a network/ticker column, not a bare word

def btc_payment_context(line, paypage):
    """BTC evidence must read as payment acceptance, not editorial text about bitcoin."""
    if BADGE_RX.match(line.strip()): return True
    if NOT_PAYMENT_RX.search(line): return False
    if ACCEPT_RX.search(line): return True
    if EDITORIAL_RX.search(line): return False
    if paypage and LIST_ROW_RX.search(line) and len(line) <= 100: return True   # payment-method table/list row
    return bool(paypage and CTX.search(line))

def question_lends_context(prev):
    """True when prev (the segment immediately before, same line) is a question that itself names payment (CTX)."""
    return bool(prev) and prev.rstrip().endswith("?") and bool(CTX.search(prev))

def normalize_text(t):
    """Evidence normalization (the ONE definition; evidence_sha hashes its UTF-8 bytes):
    1. Unicode NFC; 2. every run of whitespace (\\s+, incl. newlines/tabs/NBSP) -> one ASCII space; 3. strip ends."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", t or "")).strip()

def evidence_sha(t):
    """sha256 hex of the normalized UTF-8 text."""
    return hashlib.sha256(normalize_text(t).encode("utf-8")).hexdigest()

def store_evidence_text(t, evidence_dir):
    """Content-addressed blob: <evidence_dir>/<sha>.txt holds normalize_text(t). Idempotent. Returns sha."""
    sha = evidence_sha(t)
    if evidence_dir:
        os.makedirs(evidence_dir, exist_ok=True)
        path = os.path.join(evidence_dir, sha + ".txt")
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as f: f.write(normalize_text(t))
    return sha

def utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def btc_provenance(q, sha=None, fetched_at=None):
    """Spec v9.2 s1: BTC evidence read from page text is what the store says, never something KlickyMart observed.
    snapshot_id: crawl records carry no snapshot id yet, so it is None. evidence_sha = sha256 of the normalized
    extracted page text the quote came from (see normalize_text); fetched_at = ISO-8601 UTC; url = page url."""
    q["provenance"] = "store-asserted"; q["snapshot_id"] = None
    q["evidence_sha"] = sha; q["fetched_at"] = fetched_at
    return q

def extract_payments(texts, evidence_dir=None):
    """texts: (url, step, title, text[, fetched_at]). Text is NFC-normalized first so every quote is a substring
    of normalize_text(text). If evidence_dir is set, the normalized blob is stored there as <evidence_sha>.txt."""
    pay, no, quotes = set(), set(), []
    for item in texts:
        url, step, title, t = item[:4]
        fetched_at = item[4] if len(item) > 4 and item[4] else utc_now_iso()
        t = unicodedata.normalize("NFC", t or "")
        sha = None
        def prov(q):
            nonlocal sha
            if sha is None: sha = store_evidence_text(t, evidence_dir)
            return btc_provenance(q, sha, fetched_at)
        paypage = step == "help" and bool(PAYPAGE.search(url + " " + title))
        lines = [re.sub(r"\s+", " ", l).strip() for l in t.splitlines()]
        lines = [l for l in lines if l]
        ugc = ugc_mask(lines, paypage)
        head_scope = None
        for i, line in enumerate(lines):
            if line.startswith("## "):
                head_scope = "in-store" if SCOPE_HEAD_INSTORE.match(line) else ("online" if SCOPE_HEAD_ONLINE.match(line) else None)
            if ugc[i] or line.startswith("## "): continue   # headings set scope; they are not evidence themselves
            if NAV.match(line): continue
            ok_ctx = paypage or (len(line) >= 25 and CTX.search(line)) or bool(BADGE_RX.match(line))
            if not ok_ctx: continue
            for code, rx in TERMS:
                if not re.search(rx, line, flags=re.I): continue
                # sentence-level negation: "SNAP EBT is accepted online. Cash EBT is not accepted." -> one pos, one neg
                parts = re.split(r"(?<=[.!?])\s+", line)
                segs = [(x, parts[j - 1] if j else None) for j, x in enumerate(parts) if re.search(rx, x, flags=re.I)] or [(line, None)]
                for seg, prev in segs:
                    # FAQ gap (spec): a sentence segment ending in '?' is a question, never BTC evidence
                    if code in BTC_STRICT and seg.rstrip().endswith("?"): continue
                    # payment context (incl. NOT_PAYMENT_RX) is judged per sentence segment, not per whole line
                    # a segment may borrow context ONLY from the question segment immediately before it, and only when that
                    # question matches CTX ("Which payment methods do you take? Card and Bitcoin."); nothing else on the line lends
                    if code in BTC_STRICT and (NOT_PAYMENT_RX.search(seg) or not (btc_payment_context(seg, paypage)
                                               or question_lends_context(prev))): continue
                    neg = bool(NEG.search(seg))
                    (no if neg else pay).add(code)
                    sc = line_scope(seg, None) or line_scope(line, head_scope)
                    if not any(q["c"] == code and q["neg"] == neg and q["scope"] == sc for q in quotes):
                        q = {"c": code, "neg": neg, "url": url, "q": seg[:240],
                             "conf": "med" if paypage else "low", "scope": sc}
                        quotes.append(prov(q) if code in BTC_STRICT else q)
        for i, line in enumerate(lines):
            if ugc[i]: continue
            if re.search(r"(?i)on-?chain payments only", line):
                no.add("ln"); pay.discard("ln")
                quotes.append(prov({"c": "ln", "neg": True, "url": url, "q": line[:240], "conf": "med", "scope": line_scope(line)}))
    if pay & {"btc", "eth", "usdt", "usdc", "ltc", "xmr"}: pay.discard("crypto")
    return sorted(pay), sorted(no - pay), quotes

def scope_split(quotes):
    """Per-scope method lists from scoped quotes. 'both' counts for both; null scope goes to pay_unscoped."""
    on, st, un = set(), set(), set()
    for q in quotes:
        if q["neg"]: continue
        sc = q.get("scope")
        if sc in ("online", "both"): on.add(q["c"])
        if sc in ("in-store", "both"): st.add(q["c"])
        if sc is None: un.add(q["c"])
    allp = on | st | un
    if allp & {"btc", "eth", "usdt", "usdc", "ltc", "xmr"}: on.discard("crypto"); st.discard("crypto"); un.discard("crypto")
    return sorted(on), sorted(st), sorted(un - on)   # unscoped = seen without scope and not confirmed online
