#!/usr/bin/env python3
"""Generate the crawler keypair once. Writes nsec to ../secrets/crawler.nsec (0600). Prints npub only."""
import os, sys
from nostr_sdk import Keys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "secrets", "crawler.nsec")
if os.path.exists(P): sys.exit("key exists; refusing to overwrite")
os.makedirs(os.path.dirname(P), exist_ok=True)
k = Keys.generate()
fd = os.open(P, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f: f.write(k.secret_key().to_bech32())
open(os.path.join(os.path.dirname(P), "crawler.npub"), "w").write(k.public_key().to_bech32() + "\n")
print(k.public_key().to_bech32())
