"""GO D2/G4 guard: block any non-GET request that could place an order or confirm a payment. Installed on every probe context."""
import re
DENY = re.compile(r"(place[-_]?order|submit[-_]?order|complete[-_]?order|placeorder|submitorder|/orders?/(create|place|submit|complete)|/checkout/(complete|submit|processing|process_payment)"
                  r"|payment[-_]?intents?/[^/]+/confirm|/payments?/(confirm|submit|authori[sz]e|capture|process)|/v1/payment_intents/.+/confirm|/charge(s)?(/|$|\?)|/pay(/|\?|$))", re.I)
def is_denied(method: str, url: str) -> bool:
    return method.upper() != "GET" and bool(DENY.search(url))
def install(ctx, log=None):
    def handler(route, request):
        if is_denied(request.method, request.url):
            if log is not None: log.append(("blocked", request.method, request.url[:200]))
            return route.abort("blockedbyclient")
        return route.continue_()
    ctx.route("**/*", handler)
