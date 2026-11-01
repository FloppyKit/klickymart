"""GO D8 design (NOT wired to publish, NOT running anywhere): serve shopper watches expressed as kind 420 needs.
A watch = kind 420 with ["t","watch"], a product key (["l","gtin:<gtin>","nip-xx"] or ["a","31421:<pk>:<d>"]), conditions
(["cond","price<","199.00","USD"] / ["cond","stock","in"]) and NIP-40 ["expiration","<unix>"].
On a matched change the server emits a fresh 31421 offer plus a 421 that tags the need and ["proof","event","<31421-id>"].
Abuse limits: MAX_WATCHES_PER_KEY active watches per pubkey; at most 1 recheck per store per RECHECK_S no matter how many watchers
(rechecks are coalesced across watchers). The signer is injected; tests use a throwaway key generated in-test, never the crawler key."""
import json, time
from dataclasses import dataclass, field
from kinds import KIND_NEED, KIND_FULFILL, KIND_OFFER, NS
MAX_WATCHES_PER_KEY = 20
RECHECK_S = 600

@dataclass
class Watch:
    id: str; pubkey: str; gtin: str | None; domain: str | None; price_lt: float | None; want_stock: str | None; expires: int

def parse_watch(ev: dict, now: int):
    """Return a Watch or (None, reason)."""
    if ev.get("kind") != KIND_NEED: return None, "not a 420"
    tags = ev.get("tags") or []
    if ["t", "watch"] not in tags: return None, "no t=watch"
    gtin = next((t[1][5:] for t in tags if len(t) > 2 and t[0] == "l" and t[1].startswith("gtin:") and t[2] == NS), None)
    dom = next((t[1] for t in tags if t[0] == "r" and len(t) > 1), None)
    price = next((float(t[2]) for t in tags if t[0] == "cond" and len(t) > 2 and t[1] == "price<"), None)
    stock = next((t[2] for t in tags if t[0] == "cond" and len(t) > 2 and t[1] == "stock"), None)
    exp = next((int(t[1]) for t in tags if t[0] == "expiration" and len(t) > 1), None)
    if not gtin: return None, "no product key"
    if exp is None or exp <= now: return None, "missing or past expiration"
    if price is None and stock is None: return None, "no condition"
    return Watch(ev["id"], ev["pubkey"], gtin, dom, price, stock, exp), None

@dataclass
class WatchServer:
    """In-memory model of the serving loop. recheck(domain, gtin) -> offer dict | None is injected (D9 recheck, robots-first)."""
    recheck: callable; sign: callable; publish: callable
    watches: dict = field(default_factory=dict); last_check: dict = field(default_factory=dict); last_offer: dict = field(default_factory=dict)
    def add(self, ev, now):
        w, why = parse_watch(ev, now)
        if not w: return False, why
        if sum(1 for x in self.watches.values() if x.pubkey == w.pubkey and x.expires > now) >= MAX_WATCHES_PER_KEY: return False, "too many active watches for this key"
        self.watches[w.id] = w; return True, None
    def tick(self, now):
        """One pass: coalesce by (domain,gtin); at most one recheck per store per RECHECK_S."""
        out = []
        keys = {(w.domain, w.gtin) for w in self.watches.values() if w.expires > now}
        for dom, gtin in sorted(keys, key=str):
            if now - self.last_check.get(dom, -10**9) < RECHECK_S: continue
            self.last_check[dom] = now
            offer = self.recheck(dom, gtin)
            if not offer: continue
            prev = self.last_offer.get((dom, gtin)); self.last_offer[(dom, gtin)] = offer
            if prev and prev["price"] == offer["price"] and prev["stock"] == offer["stock"]: continue
            o_ev = self.sign({"kind": KIND_OFFER, "created_at": now, "content": json.dumps(offer, separators=(",", ":")),
                              "tags": [["d", f"{offer['domain']}:gtin:{gtin}"], ["r", offer["domain"]], ["price", str(offer["price"]), offer["cur"]], ["checked_at", str(now)], ["u", offer["url"]], ["L", NS], ["l", f"gtin:{gtin}", NS], ["l", f"stock:{offer['stock']}", NS]]})
            self.publish(o_ev); out.append(o_ev)
            for w in self.watches.values():
                if (w.domain, w.gtin) != (dom, gtin) or w.expires <= now: continue
                hit = (w.price_lt is None or offer["price"] < w.price_lt) and (w.want_stock is None or offer["stock"] == w.want_stock)
                if hit:
                    f_ev = self.sign({"kind": KIND_FULFILL, "created_at": now, "content": f"{offer['domain']} {offer['cur']} {offer['price']} {offer['stock']}",
                                      "tags": [["e", w.id, "", "need"], ["p", w.pubkey], ["proof", "event", o_ev["id"]]]})
                    self.publish(f_ev); out.append(f_ev)
        return out
