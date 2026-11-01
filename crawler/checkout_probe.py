#!/usr/bin/env python3
"""Guest checkout probe: add one cheap in-stock item to cart, go to checkout ONLY up to the payment-method screen,
record offered methods, stop. Never submits an order, never logs in or creates an account, never types personal data.
Usage: checkout_probe.py --only a.com,b.com [--out out/checkout.jsonl]   |   checkout_probe.py --candidates out/btc-candidates.txt
Reuses crawl.py's UA, robots and wall helpers by import (their behavior is unchanged)."""
import argparse, json, os, re, sys, time
from urllib.parse import urljoin, urlparse
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import crawl
from url_redact import redact
from checkout_parse import find_methods, find_processors, classify_gate, btc_offered, privacy_hints, PAY_SCREEN_RX

MAX_LOADS = 15
NAV_TIMEOUT = max(crawl.NAV_TIMEOUT, 60000)   # big retailers (bestbuy.com) take >30s to DOMContentLoaded headless
# Matt's rule (2026-10-29): guest contact step only. Never card, phone, address, account, or order submission.
CONTACT_NAME = "Klicky Bot"
CONTACT_EMAIL_FMT = "bot+{slug}@klickymart.com"
CONTINUE_SEL = ["button:has-text('Continue to payment')", "button:has-text('Continue to shipping')",
                "button:has-text('Continue')", "button:has-text('Next')"]
SPACING = max(2.0, crawl.PACE)
FORBIDDEN = re.compile(r"(?i)place (your )?order|complete (order|purchase)|pay now|confirm|submit|buy now|sign ?in|log ?in|create account|register|subscribe|pay \$")
ATC_SEL = ["form[action*='/cart/add'] button[type=submit]", "form[action*='/cart/add'] [name=add]",
           "button[name=add-to-cart]", "button.single_add_to_cart_button", "[data-testid*=add-to-cart i]",
           "button:has-text('Add to cart')", "button:has-text('Add to Cart')", "button:has-text('Add to bag')",
           "button:text-matches('add to (cart|bag|basket)', 'i')", "[role=button]:text-matches('add to (cart|bag)', 'i')",
           "[aria-label*='add to cart' i]", "[aria-label*='add to bag' i]", "input[type=submit][value*='cart' i]",
           "form[action*='cart'] button[type=submit]", "form[action*='basket'] button[type=submit]",
           "button:text-matches('^\\s*(add|buy|order)( now| it| to cart)?\\s*$', 'i')"]
CHECKOUT_SEL = ["button[name=checkout]", "a.checkout-button", "a[href*='/checkout']", "button:has-text('Check out')",
                "button:has-text('Checkout')", "a:has-text('Checkout')", "a:has-text('Proceed to checkout')",
                "input[name=checkout]", "button:text-matches('check ?out|proceed', 'i')", "a:text-matches('check ?out|proceed', 'i')",
                "[aria-label*='checkout' i]"]
PRODUCT_HREF = re.compile(r"/products?/[^/?#]+|/shop/[^/?#]+/?$|/p/[^/?#]+|/item/[^/?#]+|/store/[^/?#]+"
                          r"|/site/[^?#]+\.p$|/dp/[A-Z0-9]{10}|/ip/[^/?#]+/\d+|/gift-cards/[a-z0-9]+[_-][a-z0-9_-]+/?$|/pd/[^/?#]+|/sku/[^/?#]+|-p-\d+|/product-detail/")
SHOP_HREF = re.compile(r"(?i)/(shop|store|products|collections/all)/?$")

class Budget(Exception): pass

class Site:
    def __init__(self, d, ctx, rp, shots):
        self.d, self.ctx, self.rp, self.shots = d, ctx, rp, shots
        self.loads, self.last = 0, 0.0
    def allowed(self, url): return self.rp.can_fetch(crawl.UA_TOKEN, url)
    def tick(self):
        if self.loads >= MAX_LOADS: raise Budget()
        wait = SPACING - (time.time() - self.last)
        if wait > 0: time.sleep(wait)
        self.loads += 1; self.last = time.time()
    def goto(self, page, url):
        self.tick(); r = page.goto(url, timeout=NAV_TIMEOUT, wait_until="domcontentloaded")
        try: page.wait_for_load_state("networkidle", timeout=8000)
        except Exception: pass
        dismiss_overlays(page)
        return r.status if r else None
    def shot(self, page, tag):
        p = os.path.join(self.shots, f"{self.d}_{tag}.png")
        try: page.screenshot(path=p, full_page=True); return os.path.relpath(p, HERE)
        except Exception: return None

OVERLAY_RX = re.compile(r"(?i)^\s*(accept( all)?( cookies)?|i accept|agree|got it|ok|close|no,? thanks|not now|dismiss|continue shopping|stay on (this )?site|×|x)\s*$")
def dismiss_overlays(page):
    """Close cookie banners / promo modals that cover buttons. Clicks only plainly-labeled dismiss buttons."""
    try:
        for el in page.query_selector_all("button:visible,[role=button]:visible,[aria-label*=close i]:visible")[:60]:
            lab = ((el.inner_text() or "") or el.get_attribute("aria-label") or "").strip()
            if lab and len(lab) < 30 and OVERLAY_RX.match(lab) and not FORBIDDEN.search(lab):
                try: el.click(timeout=2000); time.sleep(0.4)
                except Exception: pass
    except Exception: pass

ROLE_RX = {"atc": re.compile(r"(?i)^\W*(add to (cart|bag|basket|order)|add|add item|buy gift card|purchase gift card)\b|\badd to (cart|bag|basket)\b"),
           "checkout": re.compile(r"(?i)^\s*(secure )?(check ?out|proceed to (checkout|payment)|go to checkout|continue to checkout|checkout now)\b"),
           "guest": re.compile(r"(?i)(continue|check ?out|proceed|shop) as (a )?guest|guest check ?out|continue without (an )?account|checkout without (an )?account")}

def role_click(site, page, kind):
    """Accessible-name fallback (buttons/links whose text is in nested spans, web components, etc.)."""
    rx = ROLE_RX[kind]
    for role in ("button", "link"):
        try: loc = page.get_by_role(role, name=rx)
        except Exception: continue
        try: n = min(loc.count(), 6)
        except Exception: n = 0
        for i in range(n):
            el = loc.nth(i)
            try:
                if not el.is_visible(): continue
                label = (el.inner_text(timeout=2000) or el.get_attribute("aria-label") or "").strip()
                if FORBIDDEN.search(label) and kind != "guest": continue
                if kind == "guest" and re.search(r"(?i)sign ?in|log ?in|create", label) and not rx.search(label): continue
                try: el.scroll_into_view_if_needed(timeout=3000)
                except Exception: pass
                site.tick(); el.click(timeout=10000)
                try: page.wait_for_load_state("networkidle", timeout=10000)
                except Exception: pass
                time.sleep(1.5)
                return f"role={role}:{kind}", label[:80]
            except Budget: raise
            except Exception: continue
    if kind == "atc":   # plain text node inside a clickable div/span (no button role)
        try:
            loc = page.get_by_text(re.compile(r"(?i)^\W*add to (cart|bag|basket)\W*$"))
            for i in range(min(loc.count(), 4)):
                el = loc.nth(i)
                if not el.is_visible(): continue
                site.tick(); el.click(timeout=10000)
                try: page.wait_for_load_state("networkidle", timeout=10000)
                except Exception: pass
                time.sleep(1.5); return "text:atc", "Add to cart"
        except Budget: raise
        except Exception: pass
    return None

def choose_variants(page):
    """Pick the first real option in required selects / first enabled swatch, so add-to-cart is enabled. No typing."""
    picked = []
    try:
        for el in page.query_selector_all("select:visible")[:4]:
            opts = el.eval_on_selector_all("option", "os => os.filter(o => o.value && !o.disabled).map(o => o.value)")
            cur = el.evaluate("e => e.value")
            if opts and (not cur or cur in ("", "0", "select")):
                el.select_option(value=opts[0]); picked.append("select")
        for grp in page.query_selector_all("[role=radiogroup]:visible, fieldset:visible")[:3]:
            if grp.query_selector("input:checked, [aria-checked=true]"): continue
            opt = grp.query_selector("input[type=radio]:not([disabled]), [role=radio]:not([aria-disabled=true])")
            if opt:
                try: opt.check(timeout=3000) if opt.evaluate("e => e.tagName") == "INPUT" else opt.click(timeout=3000); picked.append("radio")
                except Exception: pass
    except Exception: pass
    return picked

GUEST_TEXT = re.compile(r"(?i)(continue|check ?out|proceed|shop) as (a )?guest|guest check ?out|continue without (an )?account|checkout without (an )?account|no account (needed|required)")
TAX_RX = re.compile(r"(?i)\b(estimated |sales )?tax(es)?\b[^\n]{0,40}(\$\s?\d|calculated|tbd|--)")
SHIP_RX = re.compile(r"(?i)\b(shipping|delivery)\b[^\n]{0,40}(\$\s?\d|free\b|calculated|tbd)")
def landed_cost(text):
    """What the page shows before any payment step: shipping and tax lines (with amounts or 'calculated at next step')."""
    out = {}
    for k, rx in (("ship", SHIP_RX), ("tax", TAX_RX)):
        m = rx.search(text or "")
        if m:
            line = (text[max(0, text.rfind("\n", 0, m.start()) + 1): text.find("\n", m.end()) if text.find("\n", m.end()) > 0 else m.end()]).strip()
            out[k] = {"q": line[:160], "amount": bool(re.search(r"\$\s?\d|\bfree\b", m.group(0), re.I))}
    return out

EMPTY_CART = re.compile(r"(?i)(your )?(shopping )?(cart|bag|basket) is (currently )?empty|no items in (your )?(cart|bag)")
STRONG_PRODUCT = re.compile(r"/site/[^?#]+\.p$|/dp/|/ip/|/products/|/product/|/gift-cards/[a-z0-9]+[_-]")
def rank_products(urls):
    seen, out = set(), []
    for u in sorted(urls, key=lambda u: (0 if STRONG_PRODUCT.search(urlparse(u).path) else 1, len(u))):
        if u not in seen: seen.add(u); out.append(u)
    return out

PRICE_LINKS_JS = """() => {
  const host = location.host, out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    let u; try { u = new URL(a.href); } catch (e) { continue; }
    if (u.host !== host || u.pathname.length < 4 || /\\/(cart|checkout|account|login|signin|help|search)/i.test(u.pathname)) continue;
    let el = a, ok = false;
    for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
      const t = (el.innerText || '').slice(0, 400);
      if (/[$€£]\\s?\\d/.test(t) && t.length < 400) { ok = true; break; }
    }
    if (ok && a.offsetParent) out.push(u.href.split('#')[0]);
  }
  return [...new Set(out)].slice(0, 20);
}"""
CATEGORY_HREF = re.compile(r"(?i)/(c|category|categories|collections|shop|browse|store|deals|gift-cards?|best-?sellers?)(/|$)|\.c$|/cat\d")
def price_links(page):
    """Same-host links inside a card that shows a price: product tiles on home/category pages, whatever the URL shape."""
    try: return page.evaluate(PRICE_LINKS_JS)
    except Exception: return []

def safe_click(site, page, selectors):
    for sel in selectors:
        try: el = page.query_selector(sel)
        except Exception: continue
        if not el or not el.is_visible(): continue
        label = (el.inner_text() or el.get_attribute("value") or "").strip()
        if FORBIDDEN.search(label): continue
        site.tick(); el.click(timeout=10000)
        try: page.wait_for_load_state("networkidle", timeout=10000)
        except Exception: pass
        time.sleep(1.5)
        return sel, label[:80]
    return None

def site_slug(d):
    """Registrable-domain label: shop.example.co.uk -> example, store.coinkite.com -> coinkite."""
    parts = d.lower().split(".")
    if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in ("co", "com", "org", "net", "ac", "gov"): return parts[-3]
    return parts[-2] if len(parts) >= 2 else parts[0]

LOCAL_CFG = os.path.join(HERE, "probe.local.json")   # gitignored; holds the business address

def load_local_cfg(path=LOCAL_CFG):
    """{"name","email_fmt","address":{line1,line2,city,state,zip,country}} or {} if absent."""
    if not os.path.exists(path): return {}
    with open(path) as f: return json.load(f)

ADDR_KEYS = [("line2", r"address.?2|apartment|suite|apt|line.?2"), ("line1", r"address.?1|street|address|line.?1"),
             ("city", r"city|locality|town"), ("state", r"state|province|region|zone"),
             ("zip", r"zip|postal|postcode"), ("country", r"country")]

def field_kind(desc):
    lf = desc.lower()
    if re.search(r"card|cc-|cvc|cvv|password|expir", lf): return "forbidden"
    if re.search(r"phone|tel\b|mobile", lf): return "phone"
    if "email" in lf: return "email"
    if re.search(r"first.?name|given", lf): return "first"
    if re.search(r"last.?name|family|surname", lf): return "last"
    for k, rx in ADDR_KEYS:
        if re.search(rx, lf): return "addr:" + k
    if re.search(r"(^|\W)(full.?)?name($|\W)", lf): return "name"
    return None

def contact_plan(fields, d, cfg=None):
    """[(field_desc, kind, value)] for allowed fields. None if an address is needed but no local address is configured."""
    cfg = cfg or {}
    name = cfg.get("name", CONTACT_NAME); first, last = (name.split(" ", 1) + [""])[:2]
    email = cfg.get("email_fmt", CONTACT_EMAIL_FMT).format(slug=site_slug(d))
    addr = cfg.get("address") or {}
    vals = {"email": email, "first": first, "last": last, "name": name}
    plan = []
    for f in fields:
        k = field_kind(f)
        if k is None or k in ("forbidden", "phone"): continue
        if k.startswith("addr:"):
            if not addr: return None
            v = addr.get(k[5:])
            if v: plan.append((f, k, v))
        else: plan.append((f, k, vals[k]))
    return plan

def phone_required(page):
    try:
        return bool(page.eval_on_selector_all("input:visible",
            "els => els.some(e => /phone|tel|mobile/i.test([e.name,e.id,e.autocomplete,e.type,e.placeholder].join(' ')) && (e.required || e.getAttribute('aria-required')==='true'))"))
    except Exception: return False

def fill_contact(page, plan):
    """The only place the probe enters data. Records field names; address values are redacted in the log."""
    done = []
    for el in page.query_selector_all("input:visible,select:visible"):
        desc = " ".join(filter(None, [el.get_attribute(a) for a in ("name", "id", "autocomplete", "placeholder", "aria-label")]))
        for key, kind, val in plan:
            if desc != key or el.get_attribute("type") in ("password", "tel", "hidden"): continue
            try:
                if el.evaluate("e => e.tagName") == "SELECT":
                    try: el.select_option(label=val)
                    except Exception: el.select_option(value=val)
                else: el.fill(val)
                done.append({"field": key, "kind": kind, "value": "<address>" if kind.startswith("addr:") else val})
            except Exception: pass
            break
    return done

def shopify_cheapest(site, base):
    url = base + "/products.json?limit=250"
    if not site.allowed(url): return None
    site.tick()
    try:
        r = site.ctx.request.get(url, timeout=20000)
        if not r.ok: return None
        best = None
        for p in r.json().get("products", []):
            for v in p.get("variants", []):
                price = float(v.get("price") or 0)
                if v.get("available") and price > 0 and (best is None or price < best[0]):
                    best = (price, f"{base}/products/{p['handle']}?variant={v['id']}")
        return best[1] if best else None
    except Exception: return None

PAY_CONTAINER_SEL = ("#payment, .wc_payment_methods, [class*=payment-method i], [id*=payment-method i], [data-testid*=payment i], "
                     "fieldset:has(legend:text-matches('payment', 'i')), section:has(h2:text-matches('payment', 'i'))")
def payment_text(page):
    """Visible text of payment-option containers only (so product titles never count as evidence); '' if none."""
    try:
        return "\n".join(t for t in page.eval_on_selector_all(PAY_CONTAINER_SEL, "els => els.filter(e => e.offsetParent).map(e => e.innerText)") if t)
    except Exception: return ""

def processor_urls(page):
    """Public URLs on the checkout page that mention a BTC processor (script/iframe/form/link/img), for self-hosting evidence."""
    try:
        urls = page.eval_on_selector_all("script[src],iframe[src],form[action],a[href],img[src],link[href]", "els => els.map(e => e.src || e.href || e.action)")
    except Exception: urls = []
    urls += [f.url for f in page.frames]
    return sorted({u for u in urls if re.search(r"(?i)btcpay|opennode|strike|bitpay|zaprite|ibex|lnbits|blink|coinbase", u or "")})[:20]

def sitemap_products(site, base, limit=2):
    """Product URLs from /sitemap.xml (one level of sitemap index; prefers product sitemaps). Respects robots and budget."""
    def get(u):
        if not site.allowed(u): return ""
        site.tick()
        try:
            r = site.ctx.request.get(u, timeout=20000)
            return r.text() if r.ok else ""
        except Exception: return ""
    xml = get(base + "/sitemap.xml")
    locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", xml)
    subs = [u for u in locs if u.endswith(".xml") or "sitemap" in u]
    if subs:
        subs.sort(key=lambda u: 0 if "product" in u else 1)
        locs = []
        for u in subs[:limit]:
            locs += re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", get(u))
            if any(PRODUCT_HREF.search(urlparse(x).path) for x in locs): break
    return [u for u in locs if PRODUCT_HREF.search(urlparse(u).path) and site.allowed(u)]

def visible_fields(page):
    return page.eval_on_selector_all("input:visible,select:visible,textarea:visible",
        "els => els.filter(e => !['hidden','submit','button','checkbox','radio'].includes(e.type)).map(e => [e.name,e.id,e.autocomplete,e.placeholder,e.getAttribute('aria-label')].filter(Boolean).join(' '))")

def probe(browser, d, tos, out_dir):
    res = {"d": d, "ts": crawl.now(), "ua": crawl.UA, "vantage": crawl.VANTAGE, "step_reached": None, "pm_visible": None,
           "methods": [], "processors": [], "btc_offered": "unknown", "privacy": [], "shot": None, "loads": 0, "n": None, "path": []}
    t = tos.get(d) or {}
    if t.get("tos") == "bans-automation":
        res.update(step_reached="skipped", n="tos bans automation", tos_url=t.get("url")); return res
    ctx = browser.new_context(user_agent=crawl.UA, viewport={"width": 1280, "height": 1600})
    import order_guard; order_guard.install(ctx)   # G4: abort order/payment POSTs
    base = "https://" + (d if d.count(".") > 1 else "www." + d)
    try:
        rp, rinfo = crawl.load_robots(ctx, base)
        if rinfo["status"] != 200 and not (isinstance(rinfo["status"], int) and 400 <= rinfo["status"] < 500 and rinfo["status"] not in (401, 403)):
            res.update(step_reached="skipped", n=f"robots.txt {rinfo['status']}"); return res
        site = Site(d, ctx, rp, os.path.join(out_dir, "checkout-shots"))
        site.loads = 1   # robots.txt
        if not site.allowed(base + "/"):
            res.update(step_reached="skipped", n="robots disallows /"); return res
        page = ctx.new_page()
        try:
            st = site.goto(page, base + "/"); res["path"].append(["home", page.url, st])
            wall = crawl.detect_wall(page, st, page.title(), page.content())
            if wall: res.update(step_reached="home_blocked", n=f"wall {wall}", shot=site.shot(page, "blocked")); return res
            res["step_reached"] = "home"
            base = f"{urlparse(page.url).scheme}://{urlparse(page.url).netloc}"
            purl = shopify_cheapest(site, base)
            hrefs = page.eval_on_selector_all("a[href]", "els => els.map(e => e.href)")
            if not purl:
                purl = (rank_products([h for h in hrefs if urlparse(h).netloc == urlparse(base).netloc and PRODUCT_HREF.search(urlparse(h).path) and site.allowed(h)]) or [None])[0]
            if not purl:
                sm = sitemap_products(site, base); res["sitemap_products"] = len(sm)
                purl = sm[0] if sm else None
                if purl: res["path"].append(["sitemap", purl])
            if not purl:   # product tiles with a visible price
                pl = [h for h in price_links(page) if site.allowed(h)]
                if pl: purl = pl[0]; res["path"].append(["price_tile", purl])
            if not purl:   # one hop to a category page, then price tiles there
                cat = next((h for h in rank_products([]) or hrefs if urlparse(h).netloc == urlparse(page.url).netloc and CATEGORY_HREF.search(urlparse(h).path) and site.allowed(h)), None)
                if cat:
                    st = site.goto(page, cat); res["path"].append(["category", page.url, st])
                    if not crawl.detect_wall(page, st, page.title(), page.content()):
                        hrefs = page.eval_on_selector_all("a[href]", "els => els.map(e => e.href)")
                        pl = [h for h in price_links(page) if site.allowed(h)] or rank_products([h for h in hrefs if urlparse(h).netloc == urlparse(page.url).netloc and PRODUCT_HREF.search(urlparse(h).path) and site.allowed(h)])
                        if pl: purl = pl[0]
            if not purl:   # one hop to a shop/store index page (e.g. Start9-style sites)
                shop = next((h for h in hrefs if urlparse(h).netloc.endswith(d) and SHOP_HREF.search(urlparse(h).path) and site.allowed(h)), None)
                if shop:
                    st = site.goto(page, shop); res["path"].append(["shop", page.url, st])
                    base = f"{urlparse(page.url).scheme}://{urlparse(page.url).netloc}"
                    purl = shopify_cheapest(site, base) if urlparse(page.url).netloc != urlparse(res["path"][0][1]).netloc else None
                    if not purl:
                        hrefs = page.eval_on_selector_all("a[href]", "els => els.map(e => e.href)")
                        purl = next((h for h in hrefs if urlparse(h).netloc == urlparse(page.url).netloc and PRODUCT_HREF.search(urlparse(h).path) and site.allowed(h)), None)
            if not purl: res.update(n="no product link found", shot=site.shot(page, "home")); return res
            # up to 3 product candidates: strong product URL shapes first, then the discovered one
            cands = [purl] + rank_products([h for h in hrefs if urlparse(h).netloc == urlparse(purl).netloc and h != purl and PRODUCT_HREF.search(urlparse(h).path) and site.allowed(h)])
            c = None
            for purl in cands[:3]:
                if not site.allowed(purl): res["n"] = "product page disallowed by robots"; continue
                st = site.goto(page, purl); res["path"].append(["product", page.url, st]); res["step_reached"] = "product"
                if crawl.detect_wall(page, st, page.title(), page.content()) or (st and st in (401, 403, 429)):
                    res.update(step_reached="product_blocked", n=f"product page HTTP {st}", shot=site.shot(page, "blocked")); return res
                res["variants"] = choose_variants(page)
                c = safe_click(site, page, ATC_SEL) or role_click(site, page, "atc")
                if c: break
            if not c: res.update(n="no add-to-cart button (or out of stock)", shot=site.shot(page, "product")); return res
            res["path"].append(["add_to_cart", c[0], c[1]]); res["step_reached"] = "added_to_cart"
            for p in ("/cart", "/checkout", "/checkouts/"):
                if not site.allowed(base + p):
                    res.update(n=f"robots disallows {p}; stopped", shot=site.shot(page, "cart")); res["robots_stop"] = p; return res
            if not re.search(r"(?i)/(cart|basket|bag)", page.url):
                links = page.eval_on_selector_all("a[href]", "els => els.map(e => e.href)")
                cart = next((h for h in links if urlparse(h).netloc == urlparse(page.url).netloc and re.search(r"(?i)/(cart|basket|bag)(/|$|\\?)", urlparse(h).path + "/") and site.allowed(h)), base + "/cart")
                st = site.goto(page, cart); res["path"].append(["cart", page.url, st])
            try: body = page.inner_text("body")
            except Exception: body = ""
            if EMPTY_CART.search(body):
                res.update(n="add-to-cart click did not register (cart empty)", shot=site.shot(page, "cart")); return res
            res["step_reached"] = "cart"
            try: res["landed_cart"] = landed_cost(page.inner_text("body"))
            except Exception: pass
            c = safe_click(site, page, CHECKOUT_SEL) or role_click(site, page, "checkout")
            if not c and "/cart" in page.url:   # drawer carts: reload the cart page once
                st = site.goto(page, base + "/cart"); res["path"].append(["cart_reload", page.url, st])
                c = safe_click(site, page, CHECKOUT_SEL) or role_click(site, page, "checkout")
            if not c:   # last resort: the conventional checkout URL, when robots allows it
                for p in ("/checkout", "/checkout/"):
                    if site.allowed(base + p):
                        st = site.goto(page, base + p); res["path"].append(["checkout_direct", page.url, st])
                        if st and st < 400 and re.search(r"(?i)checkout|sign|login|guest", page.url + " " + page.title()): c = ("direct", p)
                        break
            if not c: res.update(n="no checkout button", shot=site.shot(page, "cart")); return res
            res["path"].append(["checkout_click", c[0], c[1], page.url])
            if not site.allowed(page.url):
                res.update(step_reached="checkout_disallowed", n=f"checkout URL disallowed by robots: {page.url}; not read"); return res
            res["step_reached"] = "checkout"
            text = page.inner_text("body"); html = page.content()
            frames = [f.url for f in page.frames]
            hosts = [urlparse(u).netloc for u in frames + page.eval_on_selector_all("script[src],a[href],form[action]", "els => els.map(e => e.src || e.href || e.action)")]
            fields = visible_fields(page)
            if GUEST_TEXT.search(text):
                res["guest_seen"] = GUEST_TEXT.search(text).group(0)
                g = role_click(site, page, "guest")
                if g:
                    res["path"].append(["guest_click", g[0], g[1], urlparse(page.url).path])
                    if not site.allowed(page.url):
                        res.update(step_reached="checkout_disallowed", n=f"guest URL disallowed: {urlparse(page.url).path}"); return res
                    text = page.inner_text("body"); html = page.content(); frames = [f.url for f in page.frames]
                    fields = visible_fields(page)
            if page.query_selector("input[type=password]:visible") and not re.search(r"(?i)guest|continue without|checkout as guest|express checkout", text):
                res.update(step_reached="login_required", shot=site.shot(page, "checkout")); return res
            res["landed_checkout"] = landed_cost(text)
            ptext = payment_text(page); res["pay_text_src"] = "payment-container" if ptext else "body"
            res["methods"] = find_methods(ptext or text)
            for fr in page.frames:   # card fields usually live in processor iframes (Stripe, Braintree...)
                if re.search(r"js\.stripe\.com|braintree|adyen|squareup", fr.url or ""):
                    try: ftxt = fr.inner_text("body")
                    except Exception: ftxt = ""
                    for m in find_methods(ftxt):
                        if m["c"] not in {x["c"] for x in res["methods"]}:
                            res["methods"].append(dict(m, ev=f"[iframe {urlparse(fr.url).netloc}] " + m["ev"]))
            res["processor_urls"] = processor_urls(page)
            hosts = hosts + [urlparse(u).netloc for u in res["processor_urls"]]
            res["processors"] = find_processors(html + " " + " ".join(frames + res["processor_urls"]), d, hosts)
            pay_codes = {m["c"] for m in res["methods"]}
            if res["methods"] and (not fields or (PAY_SCREEN_RX.search(text) and len(pay_codes) >= 2)):
                res.update(step_reached="payment_methods", pm_visible="yes")
            else:
                gate = classify_gate(fields)
                cfg = load_local_cfg()
                for _ in range(2):   # contact step, then (if configured) address step
                    if gate not in ("after_contact_form", "after_address"): break
                    if phone_required(page): gate = "after_phone"; break
                    plan = contact_plan(fields, d, cfg)
                    if not plan: break
                    filled = fill_contact(page, plan); res.setdefault("contact_filled", []).extend(filled)
                    c = safe_click(site, page, CONTINUE_SEL) if filled else None
                    if not c: break
                    res["path"].append(["continue", c[0], c[1], urlparse(page.url).path])
                    if not site.allowed(page.url):
                        res.update(step_reached="checkout_disallowed", n=f"post-contact URL disallowed: {urlparse(page.url).path}"); return res
                    res["step_reached"] = "after_address" if any(x["kind"].startswith("addr:") for x in filled) else "after_contact"
                    text = page.inner_text("body"); html = page.content(); frames = [f.url for f in page.frames]
                    fields = visible_fields(page); gate = classify_gate(fields)
                    ptext = payment_text(page)
                    res["methods"] = find_methods(ptext or text)
                    res["processors"] = find_processors(html + " " + " ".join(frames), d, hosts)
                    if res["methods"] and gate is None:
                        res.update(step_reached="payment_methods", pm_visible="yes"); break
                if res.get("pm_visible") != "yes":
                    if phone_required(page): gate = "after_phone"
                    res["pm_visible"] = gate or "unknown"
            res["fields_seen"] = fields[:20]
            res["landed_final"] = landed_cost(page.inner_text("body"))
            res["checkout_pages"] = 1 + sum(1 for x in res["path"] if x[0] in ("continue", "guest_click"))
            res["btc_offered"] = btc_offered(res["methods"], res["processors"], res["step_reached"])
            res["privacy"] = privacy_hints(res["methods"], res["processors"], text, guest_reached=True)
            res["shot"] = site.shot(page, "checkout")
            return res
        except Budget:
            res["n"] = f"page budget {MAX_LOADS} reached"; return res
        except Exception as e:
            res["n"] = f"error {type(e).__name__}: {str(e)[:160]}"; return res
        finally:
            res["loads"] = site.loads
    finally:
        ctx.close()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only"); ap.add_argument("--candidates"); ap.add_argument("--records")
    ap.add_argument("--out", default=os.path.join(HERE, "out", "checkout.jsonl"))
    a = ap.parse_args()
    sites = a.only.split(",") if a.only else [l.strip() for l in open(a.candidates) if l.strip() and not l.startswith("#")]
    tos = crawl.load_tos(os.path.join(HERE, "out", "tos.jsonl")) if os.path.exists(os.path.join(HERE, "out", "tos.jsonl")) else {}
    if a.records:   # ToS verdicts from the current signed records (bans-automation -> skip)
        for l in open(a.records):
            r = json.loads(json.loads(l)["content"]) if '"content"' in l[:200] else json.loads(l)
            if r.get("tos") == "bans-automation" or r.get("status") == "blocked-tos": tos[r["d"]] = {"tos": "bans-automation", "url": r.get("tos_url")}
    os.makedirs(os.path.join(HERE, "out", "checkout-shots"), exist_ok=True)
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True)
        with open(a.out, "a") as out:
            for d in sites:
                r = probe(b, d, tos, os.path.join(HERE, "out"))
                out.write(json.dumps(redact(r)) + "\n"); out.flush()  # R-C-006: redact at write time
                print(f"{d}: guest={r.get('guest_seen')} step={r['step_reached']} pm={r['pm_visible']} btc={r['btc_offered']} methods={[m['c'] for m in r['methods']]} loads={r['loads']} n={r['n']}")
        b.close()

if __name__ == "__main__": main()
