#!/bin/bash
# Base production smoke (read-only; nothing paid or published). Prints PASS/FAIL lines.
# Moved from /workspace/km-verify/km-smoke.sh on 2026-10-31 (that copy is superseded by this one).
B=https://klickymart.com
chk(){ s=$(curl -s -o /tmp/sm.out -w '%{http_code}' "$2"); [ "$s" = "${3:-200}" ] && echo "PASS $1 status=$s" || echo "FAIL $1 status=$s"; }
chk home $B/; curl -sI $B/ | grep -qi "content-security-policy: default-src 'none'" && echo "PASS csp" || echo "FAIL csp"
chk /app $B/app; chk "/check walmart" "$B/check?domain=walmart.com"; chk /landed "$B/landed?zip=60601&q=headphones&max_landed=100"
chk /report/template "$B/report/template?domain=bestbuy.com"; chk klickymart.json $B/.well-known/klickymart.json; chk llms.txt $B/llms.txt
chk chart.json $B/chart.json; chk /offers "$B/offers?type=headphones"; chk /alternatives "$B/alternatives?category=vps"; chk /merchant/bestbuy.com $B/merchant/bestbuy.com
n=$(curl -s -X POST $B/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o '"name"' | wc -l); [ $n -gt 5 ] && echo "PASS /mcp tools/list names=$n" || echo "FAIL /mcp $n"
chk favicon $B/favicon.ico; chk "/facilitate 503" $B/facilitate 503
CB=$(curl -s $B/.well-known/lnurlp/zap | python3 -c "import json,sys;print(json.load(sys.stdin)['callback'])") && echo "PASS lnurlp meta"
for a in 1000 21000; do curl -s "$CB?amount=$a" | grep -q '"pr":"lnbc' && echo "PASS zap@ bolt11 $a msat (not paid)" || echo "FAIL zap@ $a"; done
[ "$(curl -s -o /dev/null -w %{http_code} "$CB?amount=1500")" = 502 ] && echo "PASS zap@ mismatched amount refused" || echo "FAIL zap@ mismatch"
