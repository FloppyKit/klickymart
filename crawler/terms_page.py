"""Is a fetched page really a terms-of-service page? Used by tos.py before classify().
Needs (a) 'terms' or 'conditions' in the URL path, the title or the h1, and (b) enough legal-sounding text."""
import re
from urllib.parse import urlparse
NAME_RX = re.compile(r"(?i)terms|conditions|condiciones|bedingungen|conditions-generales|cgv|agb|legal")
STRICT_RX = re.compile(r"(?i)terms|conditions|condiciones|bedingungen|cgv|agb")
LEGAL_RX = re.compile(r"(?i)\b(agree(ment)?|liabilit(y|ies)|warrant(y|ies)|govern(ed|ing) (by|law)|arbitration|indemnif|intellectual property|jurisdiction|herein|terminat(e|ion)|disclaim|binding)\b")
MIN_CHARS = 1500; MIN_LEGAL_HITS = 8

def is_terms_page(url, title, h1, text):
    path = urlparse(url or "").path
    named = bool(STRICT_RX.search(path) or STRICT_RX.search(title or "") or STRICT_RX.search(h1 or ""))
    if not named: return False, "no 'terms'/'conditions' in URL, title or h1"
    if len(text or "") < MIN_CHARS: return False, f"text under {MIN_CHARS} chars"
    hits = len(LEGAL_RX.findall(text))
    if hits < MIN_LEGAL_HITS: return False, f"only {hits} legal-term hits (< {MIN_LEGAL_HITS})"
    return True, f"named + {hits} legal-term hits"
