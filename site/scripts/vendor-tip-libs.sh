#!/usr/bin/env bash
# Rebuild the vendored tipping libraries (no CDN): @cashu/cashu-ts 4.13.0 (MIT OR Apache-2.0) and qrcode-generator 2.0.4 (MIT).
# Built in a scratch dir so site dependencies stay untouched. After rebuilding, update CASHU_SRI / QR_SRI in worker/src/render/pages.ts.
set -euo pipefail
OUT="$(cd "$(dirname "$0")/.." && pwd)/public/vendor"; T="$(mktemp -d)"; cd "$T"
npm init -y >/dev/null && npm i --save-exact @cashu/cashu-ts@4.13.0 qrcode-generator@2.0.4 esbuild@0.25 >/dev/null
echo 'export { Wallet, getDecodedToken, getEncodedToken, getTokenMetadata, serializeProofs } from "@cashu/cashu-ts";' > entry.mjs
echo 'import qrcode from "qrcode-generator"; window.KMQR = qrcode;' > qr.mjs
npx esbuild entry.mjs --bundle --format=iife --global-name=CashuTs --minify --legal-comments=eof --target=es2020 --outfile="$OUT/cashu-ts-4.13.0.bundle.js"
npx esbuild qr.mjs --bundle --format=iife --minify --legal-comments=eof --outfile="$OUT/qrcode-generator-2.0.4.bundle.js"
for f in cashu-ts-4.13.0 qrcode-generator-2.0.4; do echo "$f sha384-$(openssl dgst -sha384 -binary "$OUT/$f.bundle.js" | base64)"; done
