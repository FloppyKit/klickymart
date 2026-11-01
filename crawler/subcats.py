"""Finer `sub` categories (GO 5.7, QA 2026-10-30): electronics and generalist stores get product-family subcategories so a
headphones query ranks audio sellers, not laptop makers. Order matters: first entry is the store's main line.
Hand-assigned from each store's public catalog structure; `alibaba.com` is B2B wholesale and is flagged, not ranked."""
SUBS = ["audio", "computers", "phones", "tv-video", "cameras", "gaming", "wearables", "smart-home", "appliances", "networking",
        "accessories", "gift-cards", "wholesale"]
ALL_ELEC = ["audio", "computers", "phones", "tv-video", "cameras", "gaming", "wearables", "smart-home", "appliances", "networking", "accessories"]
SUB = {
    # generalist / big-box electronics retailers: everything
    "bestbuy.com": ALL_ELEC + ["gift-cards"], "bhphotovideo.com": ["cameras", "audio", "computers", "tv-video", "accessories", "networking", "gaming", "phones", "wearables", "smart-home"],
    "newegg.com": ["computers", "gaming", "networking", "accessories", "audio", "tv-video", "smart-home", "cameras", "phones", "wearables", "appliances"],
    "amazon.com": ALL_ELEC + ["gift-cards"], "walmart.com": ALL_ELEC + ["gift-cards"], "target.com": ALL_ELEC + ["gift-cards"],
    "costco.com": ALL_ELEC + ["gift-cards"], "samsclub.com": ALL_ELEC + ["gift-cards"], "ebay.com": ALL_ELEC, "mercari.com": ALL_ELEC,
    "qvc.com": ["tv-video", "audio", "computers", "smart-home", "appliances"], "hsn.com": ["tv-video", "audio", "computers", "smart-home", "appliances"],
    "temu.com": ["accessories", "audio", "phones", "smart-home", "wearables"], "aliexpress.com": ["accessories", "audio", "phones", "smart-home", "wearables", "computers"],
    "wish.com": ["accessories", "audio", "phones"], "dhgate.com": ["accessories", "audio", "phones"], "alibaba.com": ["wholesale"],
    # brand stores
    "bose.com": ["audio"], "sonos.com": ["audio"], "sony.com": ["audio", "tv-video", "cameras", "gaming"],
    "apple.com": ["phones", "computers", "audio", "wearables", "tv-video", "accessories"], "samsung.com": ["phones", "tv-video", "appliances", "computers", "wearables", "audio"],
    "store.google.com": ["phones", "smart-home", "wearables", "audio"], "lg.com": ["tv-video", "appliances", "audio", "computers"],
    "dell.com": ["computers", "accessories"], "hp.com": ["computers", "accessories"], "lenovo.com": ["computers", "accessories"],
    "microsoft.com": ["computers", "gaming"], "logitech.com": ["accessories", "gaming", "audio", "cameras"],
    "razer.com": ["gaming", "computers", "audio", "accessories"], "corsair.com": ["gaming", "computers", "audio", "accessories"],
    "anker.com": ["accessories", "audio", "smart-home"], "eufy.com": ["smart-home", "cameras", "appliances"],
    "garmin.com": ["wearables"], "ring.com": ["smart-home", "cameras"], "canon.com": ["cameras"], "gopro.com": ["cameras"], "dji.com": ["cameras"],
    "dyson.com": ["appliances"], "gamestop.com": ["gaming", "accessories"],
    "att.com": ["phones", "wearables", "accessories"], "verizon.com": ["phones", "wearables", "accessories"], "t-mobile.com": ["phones", "wearables", "accessories"],
    # gift cards
    "bitrefill.com": ["gift-cards"], "coincards.com": ["gift-cards"], "thebitcoincompany.com": ["gift-cards"], "fold.me": ["gift-cards"],
    "g2a.com": ["gift-cards"], "starbucks.com": ["gift-cards"],
}
# Large multi-category retailers an agent's user would expect to see first among equals (ranking hint only; not a quality grade).
MAJOR = {"amazon.com", "walmart.com", "target.com", "costco.com", "samsclub.com", "bestbuy.com", "newegg.com", "bhphotovideo.com", "ebay.com",
         "homedepot.com", "lowes.com", "macys.com", "kohls.com", "staples.com", "officedepot.com"}
assert all(s in SUBS for v in SUB.values() for s in v)
