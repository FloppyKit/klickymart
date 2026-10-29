# QA report: full crawl (2026-10-29 14:13 CDT)

Records file: `out/records.final.jsonl`.

Sites in list: 250. Records: 250. Sites without a record: 0 []

Vantage: one datacenter IP (see KNOWN-LIMITATIONS.md). Not representative of residential users.

## Outcome
| status | count |
|---|---|
| crawled | 121 |
| agents-not-welcome | 70 |
| blocked-tos | 40 |
| error | 19 |

## Agents not welcome, by type
| type | count |
|---|---|
| robots-block-page | 35 |
| block-page | 16 |
| http-403 | 9 |
| robots-disallow | 4 |
| robots-403 | 3 |
| http-429 | 3 |

## Errors, by type
| type | count |
|---|---|
| robots-unreachable | 14 |
| home-unreachable | 5 |

## ToS check (tos.py)
| tos | count |
|---|---|
| None | 142 |
| ok | 68 |
| bans-automation | 40 |

## Crawled sites: agent access `ag`
| ag | count |
|---|---|
| 1 | 56 |
| 2 | 65 |

## Bitcoin grade `btc` (crawled sites)
| btc | count |
|---|---|
| 0 | 19 |
| 3 | 1 |
| None | 101 |

`btc_any` true (some bitcoin option quoted): 4. Grades 1-4 need processor/custody evidence (hand grading or a conclusive checkout probe, `btc_src`); QA-BTC-GRADE.csv lists every btc_any record.

## Restrictions seen (`ar` codes, all records)
| code | count |
|---|---|
| cap | 48 |
| tos | 40 |
| block | 35 |
| rb_ai | 27 |
| 403 | 21 |
| rb_ck | 20 |
| net | 20 |
| ak | 12 |
| cf | 11 |
| px | 10 |
| js | 5 |
| 429 | 4 |
| tarpit | 1 |

## Payment methods quoted (crawled sites, top 25)
| method | sites |
|---|---|
| card | 19 |
| gift | 11 |
| pp | 6 |
| ach | 4 |
| btc | 4 |
| bnpl:afterpay | 3 |
| apay | 3 |
| crypto | 3 |
| bnpl:klarna | 2 |
| gpay | 2 |
| usdc | 2 |
| eth | 2 |
| cashapp | 1 |
| bnpl:affirm | 1 |
| hsa | 1 |
| ltc | 1 |
| usdt | 1 |
| ln | 1 |

## BTC-positive sites (4)
| domain | status | btc grade | btc_priv | evidence |
|---|---|---|---|---|
| thebitcoincompany.com | crawled | None |  | btc: "Buy prepaid Visa and Mastercards with bitcoin and stablecoins and spend them almost anywhe" (https://www.thebitcoincompany.com/) |
| coincards.com | crawled | None |  | btc: "Buy Gift Cards With Bitcoin." (https://www.coincards.com/) |
| cryptocloaks.com | crawled | None | noacct | btc: "Bitcoin accepted" (https://www.cryptocloaks.com/); checkout btc: "Bitcoin or"; checkout ln: "Lightning" |
| start9.com | crawled | 3 | noacct,selfhosted | ln: "This is hosted by Start9, only the minimum necessary shipping information is required to p" (https://start9.com/faq/); btc: "Enter our Bitcoin Store!" (https://start9.com/faq/) |

## Guest checkout probe (19 sites)
| step reached | count |
|---|---|
| home | 8 |
| product | 6 |
| skipped | 2 |
| cart | 2 |
| payment_methods | 1 |

| domain | step | pm_visible | btc_offered | methods | note |
|---|---|---|---|---|---|
| porkbun.com | product | None | unknown |  | no add-to-cart button (or out of stock) |
| shop.ledger.com | product | None | unknown |  | error TimeoutError: ElementHandle.click: Timeout 10000ms exceeded. |
| shop.trezor.io | home | None | unknown |  | no product link found |
| bitcoinmagazine.com | home | None | unknown |  | no product link found |
| bitrefill.com | home | None | unknown |  | no product link found |
| primal.net | product | None | unknown |  | no add-to-cart button (or out of stock) |
| thebitcoincompany.com | home | None | unknown |  | no product link found |
| coincards.com | home | None | unknown |  | no product link found |
| fountain.fm | product | None | unknown |  | no add-to-cart button (or out of stock) |
| strike.me | home | None | unknown |  | no product link found |
| bisq.network | home | None | unknown |  | no product link found |
| cryptocloaks.com | payment_methods | yes | yes | btc,ln,card |  |
| foundation.xyz | product | None | unknown |  | no add-to-cart button (or out of stock) |
| start9.com | home | None | unknown |  | no product link found |
| bitkey.world | product | None | unknown |  | no add-to-cart button (or out of stock) |
| bitcoinstore.com | skipped | None | unknown |  | robots.txt err:Error |
| fold.me | skipped | None | unknown |  | robots.txt err:Error |
| coinkite.com | cart | None | unknown |  | no checkout button |
| nodl.it | cart | None | unknown |  | no checkout button |

## Agent-hostile findings (110)
| domain | status | type | quote |
|---|---|---|---|
| netflix.com | agents-not-welcome | robots-disallow | robots.txt disallows / for FloppyKitMapBot |
| adobe.com | agents-not-welcome | block-page | HTTP 403; title 'Access Denied' |
| epicgames.com | agents-not-welcome | robots-403 |  |
| godaddy.com | agents-not-welcome | robots-block-page | Access Denied |
| ebay.com | agents-not-welcome | http-403 | HTTP 403; title 'Error Page / eBay' |
| etsy.com | agents-not-welcome | http-403 | HTTP 403; title 'etsy.com' |
| ring.com | agents-not-welcome | http-403 | HTTP 403; title 'ERROR: The request could not be satisfied' |
| marriott.com | agents-not-welcome | block-page | HTTP 403; title 'Access Denied' |
| lenovo.com | agents-not-welcome | robots-block-page | Access Denied |
| disneyplus.com | agents-not-welcome | robots-disallow | robots.txt disallows / for FloppyKitMapBot |
| discogs.com | agents-not-welcome | robots-block-page | Just a moment... |
| hm.com | agents-not-welcome | robots-block-page | Access Denied |
| lowes.com | agents-not-welcome | robots-block-page | Access Denied |
| hilton.com | agents-not-welcome | http-403 | HTTP 403; title 'Hilton Page Reference Code' |
| t-mobile.com | agents-not-welcome | robots-block-page | Access Denied |
| kohls.com | agents-not-welcome | block-page | HTTP 403; title 'Access Denied' |
| tesla.com | agents-not-welcome | robots-block-page | Access Denied |
| max.com | agents-not-welcome | block-page | HTTP 403; title 'Access Denied' |
| hulu.com | agents-not-welcome | robots-disallow | robots.txt disallows / for FloppyKitMapBot |
| sony.com | agents-not-welcome | robots-block-page | Access Denied |
| expedia.com | agents-not-welcome | http-429 | HTTP 429; title 'Bot or Not?' |
| ihg.com | agents-not-welcome | robots-block-page | Access Denied |
| hyatt.com | agents-not-welcome | robots-403 | Hyatt Hotels and Resorts |
| instacart.com | agents-not-welcome | robots-disallow | robots.txt disallows / for FloppyKitMapBot |
| blueapron.com | agents-not-welcome | robots-block-page | Just a moment... |
| vrbo.com | agents-not-welcome | http-429 | HTTP 429; title 'Bot or Not?' |
| adidas.com | agents-not-welcome | robots-block-page | adidas |
| zara.com | agents-not-welcome | robots-block-page | Access Denied |
| delta.com | agents-not-welcome | block-page | HTTP 444; title 'Access Denied' |
| samsclub.com | agents-not-welcome | block-page | HTTP 200; title 'Sam's Club - Wholesale Prices on Top Brands' |
| aa.com | agents-not-welcome | block-page | HTTP 403; title 'Access Denied' |
| mcdonalds.com | agents-not-welcome | robots-block-page | Access Denied |
| macys.com | agents-not-welcome | robots-block-page | Access Denied - Macy's |
| chewy.com | agents-not-welcome | http-403 | HTTP 403; title '403 error - No treats beyond this point - Chewy' |
| farfetch.com | agents-not-welcome | block-page | HTTP 403; title 'Access Denied' |
| cars.com | agents-not-welcome | robots-block-page | Just a moment... |
| gamestop.com | agents-not-welcome | robots-block-page | Attention Required! / Cloudflare |
| dickssportinggoods.com | agents-not-welcome | robots-403 | Site Unavailable |
| rei.com | agents-not-welcome | robots-block-page | Access Denied |
| depop.com | agents-not-welcome | robots-block-page | Forbidden - Depop |
| gopuff.com | agents-not-welcome | robots-block-page | Just a moment... |
| dhgate.com | agents-not-welcome | block-page | HTTP 403; title 'Access Denied' |
| michaels.com | agents-not-welcome | robots-block-page | Access Denied |
| sephora.com | agents-not-welcome | robots-block-page | Access Denied |
| bookshop.org | agents-not-welcome | block-page | HTTP 403; title 'Just a moment...' |
| swarovski.com | agents-not-welcome | block-page | HTTP 403; title 'Access Denied' |
| stubhub.com | agents-not-welcome | http-403 | HTTP 403; title 'stubhub.com' |
| carmax.com | agents-not-welcome | robots-block-page | Access Denied |
| axs.com | agents-not-welcome | block-page | HTTP 403; title 'Just a moment...' |
| fanatics.com | agents-not-welcome | block-page | HTTP 403; title 'Access Denied' |
| torrid.com | agents-not-welcome | http-403 | HTTP 403; title 'torrid.com' |
| oreillyauto.com | agents-not-welcome | robots-block-page | Access Denied |
| bhphotovideo.com | agents-not-welcome | block-page | HTTP 403; title 'Just a moment...' |
| acehardware.com | agents-not-welcome | robots-block-page | Just a moment... |
| gopro.com | agents-not-welcome | robots-block-page | gopro.com |
| autozone.com | agents-not-welcome | http-403 | HTTP 403; title 'autozone.com' |
| staples.com | agents-not-welcome | robots-block-page | Access Denied |
| corsair.com | agents-not-welcome | robots-block-page | Just a moment... |
| booksamillion.com | agents-not-welcome | robots-block-page | Just a moment... |
| coach.com | agents-not-welcome | block-page | HTTP 403; title 'Access Denied' |

## Null audit (crawled sites)
| field | null/empty |
|---|---|
| name | 8 of 121 |
| ag | 0 of 121 |
| tos | 53 of 121 |
| btc | 101 of 121 |
| co | 121 of 121 |
| pay | 90 of 121 |
| kyc | 121 of 121 |

## Schema checks
- schema errors: 0
- pay items without a quote: 0
