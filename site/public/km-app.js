/* KlickyMart /app: Nostr-app-style login and filtered feeds, all in this browser.
 * Secret keys never leave the page. Login sends only a SIGNED kind 27235 event (NIP-98 style) to /auth/login.
 * Signers: NIP-07 extension (window.nostr), NIP-46 remote signer (bunker:// URI), or a local nsec held in memory
 * (default) or, only if you opt in, in localStorage. Feed lists are NIP-51 sets (kind 30015) signed by YOUR signer,
 * kept in this browser; they go to relays only when you press "Publish to relays". KlickyMart publishes nothing.
 * All remote text is inserted with textContent, never as HTML. */
(function () {
  "use strict";
  var NT = window.NostrTools;
  var RELAYS = ["wss://relay.primal.net", "wss://nos.lol", "wss://relay.damus.io"];
  var BUNKER_RELAYS = RELAYS.concat(["wss://relay.nsec.app"]);
  var LIST_KIND = 30015, D_PREFIX = "klickymart-feed:", NSEC_KEY = "km.app.nsec", LISTS_KEY = "km.app.lists";
  var FEED_KINDS = [31420, 420, 421, 422, 1];

  /** bunker://<remote-pubkey>?relay=wss://..&secret=.. -> {pubkey, relays, secret}; relays must be in BUNKER_RELAYS. */
  function parseBunker(uri) {
    var m = /^bunker:\/\/([0-9a-f]{64})\??(.*)$/i.exec(String(uri || "").trim());
    if (!m) throw new Error("expected bunker://<64-hex pubkey>?relay=wss://...");
    var q = new URLSearchParams(m[2]);
    var relays = q.getAll("relay").map(function (r) { return r.replace(/\/+$/, ""); });
    if (!relays.length) throw new Error("bunker URI has no relay");
    var bad = relays.filter(function (r) { return BUNKER_RELAYS.indexOf(r) === -1; });
    if (bad.length) throw new Error("this page may only connect to " + BUNKER_RELAYS.join(", ") + " (page security policy); bunker relay not allowed: " + bad.join(", "));
    return { pubkey: m[1].toLowerCase(), relays: relays, secret: q.get("secret") || "" };
  }
  /** Unsigned NIP-98-style login event for a server challenge; u is the login URL the server names (its canonical origin). */
  function authTemplate(u, challenge, now) {
    return { kind: 27235, created_at: now || Math.floor(Date.now() / 1000), content: "", tags: [["u", u], ["method", "POST"], ["challenge", challenge]] };
  }
  /** Unsigned NIP-51 kind 30015 set from a subscription. */
  function listTemplate(name, sub, now) {
    var tags = [["d", D_PREFIX + name], ["title", "KlickyMart feed: " + name]];
    (sub.kinds || []).forEach(function (k) { tags.push(["k", String(k)]); });
    (sub.tags || []).forEach(function (t) { tags.push(["t", t]); });
    (sub.stores || []).forEach(function (s) { tags.push(["r", s]); });
    (sub.authors || []).forEach(function (a) { tags.push(["p", a]); });
    return { kind: LIST_KIND, created_at: now || Math.floor(Date.now() / 1000), content: "", tags: tags };
  }
  function listToSub(ev) {
    var s = { name: "", kinds: [], tags: [], stores: [], authors: [] };
    ev.tags.forEach(function (t) {
      if (t[0] === "d") s.name = String(t[1]).slice(D_PREFIX.length);
      else if (t[0] === "k") s.kinds.push(Number(t[1]));
      else if (t[0] === "t") s.tags.push(t[1]); else if (t[0] === "r") s.stores.push(t[1]); else if (t[0] === "p") s.authors.push(t[1]);
    });
    return s;
  }
  /** Relay filters for a subscription (kind-1 notes always need #t klickymart). */
  function relayFilters(sub) {
    var kinds = sub.kinds && sub.kinds.length ? sub.kinds : FEED_KINDS;
    var base = { limit: 50 };
    if (sub.authors && sub.authors.length) base.authors = sub.authors;
    if (sub.stores && sub.stores.length) base["#r"] = sub.stores;
    var out = [];
    var other = kinds.filter(function (k) { return k !== 1; });
    if (other.length) { var f = Object.assign({}, base, { kinds: other }); if (sub.tags && sub.tags.length) f["#t"] = sub.tags; out.push(f); }
    if (kinds.indexOf(1) !== -1) out.push(Object.assign({}, base, { kinds: [1], "#t": ["klickymart"] }));
    return out;
  }
  /** The only fields of an event that ever leave the page. Refuses anything containing a secret. */
  function publicEvent(ev, skHex) {
    var out = { id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, kind: ev.kind, tags: ev.tags, content: ev.content, sig: ev.sig };
    var s = JSON.stringify(out);
    if (/nsec1[02-9ac-hj-np-z]{20,}/.test(s) || (skHex && s.indexOf(skHex) !== -1)) throw new Error("refusing to send: event contains a secret key");
    return out;
  }
  window.KMApp = { parseBunker: parseBunker, authTemplate: authTemplate, listTemplate: listTemplate, listToSub: listToSub, relayFilters: relayFilters, publicEvent: publicEvent };
  if (!document.getElementById("km-app")) return;
  if (!NT) { document.getElementById("km-app-status").textContent = "Signer library failed to load."; return; }

  var $ = function (id) { return document.getElementById(id); };
  var hex = function (b) { return Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); };
  var state = { signer: null, pubkey: null, skHex: null, pool: null };
  function status(msg) { $("km-app-status").textContent = msg; }
  function pool() { return state.pool || (state.pool = new NT.SimplePool()); }

  // ---------- signers ----------
  function nip07Signer() {
    if (!window.nostr) throw new Error("no NIP-07 extension found (window.nostr)");
    return { type: "nip07", getPublicKey: function () { return window.nostr.getPublicKey(); }, sign: function (t) { return window.nostr.signEvent(t); } };
  }
  function localSigner(sk) {
    var pk = NT.getPublicKey(sk);
    state.skHex = hex(sk);
    return { type: "local", getPublicKey: function () { return Promise.resolve(pk); }, sign: function (t) { return Promise.resolve(NT.finalizeEvent(t, sk)); } };
  }
  function nip46Signer(uri) {
    var b = parseBunker(uri);
    var csk = NT.generateSecretKey(); var cpk = NT.getPublicKey(csk); // ephemeral client key, memory only
    var ck = NT.nip44.getConversationKey(csk, b.pubkey);
    var pending = {}; var p = pool();
    var sub = p.subscribeMany(b.relays, [{ kinds: [24133], "#p": [cpk], authors: [b.pubkey] }], { onevent: function (ev) {
      if (!NT.verifyEvent(ev)) return;
      try { var r = JSON.parse(NT.nip44.decrypt(ev.content, ck)); var h = pending[r.id]; if (h) { delete pending[r.id]; r.error ? h.reject(new Error(String(r.error))) : h.resolve(r.result); } } catch (e) { /* ignore */ }
    } });
    function rpc(method, params) {
      var id = hex(NT.generateSecretKey()).slice(0, 16);
      var ev = NT.finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [["p", b.pubkey]], content: NT.nip44.encrypt(JSON.stringify({ id: id, method: method, params: params }), ck) }, csk);
      return new Promise(function (resolve, reject) {
        pending[id] = { resolve: resolve, reject: reject };
        setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error("remote signer timed out (" + method + ")")); } }, 60000);
        Promise.all(p.publish(b.relays, ev)).catch(function () { /* one relay may fail */ });
      });
    }
    var connected = rpc("connect", [b.pubkey, b.secret]);
    return { type: "nip46", close: function () { sub.close(); },
      getPublicKey: function () { return connected.then(function () { return rpc("get_public_key", []); }); },
      sign: function (t) { return connected.then(function () { return rpc("sign_event", [JSON.stringify(t)]); }).then(function (s) { var ev = typeof s === "string" ? JSON.parse(s) : s; if (!NT.verifyEvent(ev)) throw new Error("remote signer returned an invalid event"); return ev; }); } };
  }

  // ---------- login ----------
  function login(signer) {
    state.signer = signer;
    return signer.getPublicKey().then(function (pk) {
      state.pubkey = pk;
      return fetch("/auth/challenge", { credentials: "same-origin" }).then(function (r) { return r.json(); });
    }).then(function (c) {
      if (!c.challenge) throw new Error((c.error && c.error.message) || "no challenge");
      if (!/^https?:\/\/[^/]+\/auth\/login$/.test(c.u || "")) throw new Error("bad challenge response");
      return signer.sign(authTemplate(c.u, c.challenge));
    }).then(function (ev) {
      if (ev.pubkey !== state.pubkey) throw new Error("signer returned a different pubkey");
      return fetch("/auth/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: publicEvent(ev, state.skHex) }) }).then(function (r) { return r.json(); });
    }).then(function (j) {
      if (!j.ok) throw new Error((j.error && j.error.message) || "login refused");
      $("km-app-who").textContent = "Signed in as " + NT.nip19.npubEncode(state.pubkey) + " (" + signer.type + ")";
      $("km-app-feeds").hidden = false; $("km-app-logout").hidden = false;
      // Tipping (km-tip.js) gets sign/getPublicKey only; never the key itself.
      window.KMAppSigner = Object.freeze({ type: signer.type, pubkey: state.pubkey, sign: function (t) { return signer.sign(t).then(function (ev) { return publicEvent(ev, state.skHex); }); } });
      if (window.KMTip) window.KMTip.signerReady();
      status("Logged in. Your key stayed in " + (signer.type === "local" ? "this page" : signer.type === "nip07" ? "your extension" : "your remote signer") + ".");
      renderLists();
    }).catch(function (e) { status("Login failed: " + e.message); });
  }
  $("km-login-nip07").addEventListener("click", function () { try { login(nip07Signer()); } catch (e) { status(e.message); } });
  $("km-login-nip46").addEventListener("click", function () { try { status("Waiting for your remote signer to approve..."); login(nip46Signer($("km-bunker").value)); } catch (e) { status(e.message); } });
  $("km-login-local").addEventListener("click", function () {
    var raw = $("km-nsec").value.trim(); var sk;
    try {
      if (!raw) { sk = NT.generateSecretKey(); $("km-nsec-new").textContent = "New key created. Back it up now (shown once): " + NT.nip19.nsecEncode(sk); }
      else { var d = NT.nip19.decode(raw); if (d.type !== "nsec") throw new Error("expected an nsec1..."); sk = d.data; }
    } catch (e) { status("Bad key: " + e.message); return; }
    $("km-nsec").value = "";
    if ($("km-nsec-persist").checked) {
      if (!confirm("Store your secret key in this browser's localStorage? Any script or person with access to this browser profile could read it. Only do this with a throwaway key.")) { $("km-nsec-persist").checked = false; }
      else localStorage.setItem(NSEC_KEY, NT.nip19.nsecEncode(sk));
    }
    login(localSigner(sk));
  });
  try { var saved = localStorage.getItem(NSEC_KEY); if (saved) { $("km-nsec-saved").hidden = false; } } catch (e) { /* storage off */ }
  $("km-nsec-use-saved").addEventListener("click", function () { var s = localStorage.getItem(NSEC_KEY); if (s) login(localSigner(NT.nip19.decode(s).data)); });
  $("km-nsec-forget").addEventListener("click", function () { localStorage.removeItem(NSEC_KEY); $("km-nsec-saved").hidden = true; status("Saved key removed from this browser."); });
  $("km-app-logout").addEventListener("click", function () {
    fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).finally(function () {
      if (state.signer && state.signer.close) state.signer.close();
      state = { signer: null, pubkey: null, skHex: null, pool: state.pool }; window.KMAppSigner = null;
      $("km-app-feeds").hidden = true; $("km-app-logout").hidden = true; $("km-app-who").textContent = ""; status("Logged out. In-memory key cleared.");
    });
  });

  // ---------- subscriptions (NIP-51) ----------
  function loadLists() { try { return JSON.parse(localStorage.getItem(LISTS_KEY) || "[]"); } catch (e) { return []; } }
  function saveLists(ls) { localStorage.setItem(LISTS_KEY, JSON.stringify(ls)); }
  function formSub() {
    var split = function (v) { return v.split(/[\s,]+/).map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean); };
    var authors = split($("km-f-author").value).map(function (a) { if (/^npub1/.test(a)) return NT.nip19.decode(a).data; return a; });
    var kinds = Array.prototype.filter.call(document.querySelectorAll("input[name=km-f-kind]"), function (i) { return i.checked; }).map(function (i) { return Number(i.value); });
    var tags = Array.prototype.filter.call(document.querySelectorAll("input[name=km-f-tag]"), function (i) { return i.checked; }).map(function (i) { return i.value; }).concat(split($("km-f-tag-extra").value));
    return { kinds: kinds, tags: tags, stores: split($("km-f-store").value), authors: authors };
  }
  function renderLists() {
    var ul = $("km-lists"); ul.textContent = "";
    loadLists().filter(function (ev) { return ev.pubkey === state.pubkey; }).forEach(function (ev) {
      var s = listToSub(ev); var li = document.createElement("li");
      var label = document.createElement("strong"); label.textContent = s.name; li.appendChild(label);
      li.appendChild(document.createTextNode(" kinds " + (s.kinds.join(",") || "all") + "; tags " + (s.tags.join(",") || "any") + "; stores " + (s.stores.join(",") || "any") + "; authors " + s.authors.length + " "));
      [["Show", function () { loadFeed(s, $("km-src").value); }], ["Verify on server", function () { verifyList(ev); }], ["Publish to relays", function () { publishList(ev); }], ["Remove", function () { saveLists(loadLists().filter(function (x) { return x.id !== ev.id; })); renderLists(); }]].forEach(function (b) {
        var btn = document.createElement("button"); btn.type = "button"; btn.textContent = b[0]; btn.addEventListener("click", b[1]); li.appendChild(btn);
      });
      ul.appendChild(li);
    });
  }
  $("km-f-save").addEventListener("click", function () {
    var name = $("km-f-name").value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) || "default";
    var s = formSub();
    state.signer.sign(listTemplate(name, s)).then(function (ev) {
      if (!NT.verifyEvent(ev)) throw new Error("signer returned an invalid event");
      var ls = loadLists().filter(function (x) { return !(x.pubkey === ev.pubkey && x.tags[0][1] === ev.tags[0][1]); }); ls.push(publicEvent(ev, state.skHex)); saveLists(ls);
      status("Saved list '" + name + "' in this browser only (signed, not published)."); renderLists();
    }).catch(function (e) { status("Could not sign list: " + e.message); });
  });
  $("km-f-show").addEventListener("click", function () { loadFeed(formSub(), $("km-src").value); });
  function verifyList(ev) {
    fetch("/feed/list-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: publicEvent(ev, state.skHex) }) }).then(function (r) { return r.json(); })
      .then(function (j) { status(j.ok ? "Server verified the signature; it stored nothing. Feed query: " + j.feed_query : "Server rejected: " + (j.error && j.error.message)); });
  }
  function publishList(ev) {
    if (!confirm("Publish this signed list to " + RELAYS.join(", ") + "? It becomes public and KlickyMart cannot remove it.")) return;
    Promise.allSettled(pool().publish(RELAYS, publicEvent(ev, state.skHex))).then(function (rs) { status("Published to " + rs.filter(function (r) { return r.status === "fulfilled"; }).length + " of " + RELAYS.length + " relays."); });
  }

  // ---------- feed ----------
  function q(sub) { var p = new URLSearchParams(); if (sub.kinds.length) p.set("kind", sub.kinds.join(",")); if (sub.stores.length) p.set("store", sub.stores.join(",")); if (sub.tags.length) p.set("tag", sub.tags.join(",")); if (sub.authors.length) p.set("author", sub.authors.join(",")); return p.toString(); }
  function loadFeed(sub, src) {
    status("Loading feed from " + (src === "relays" ? RELAYS.join(", ") : "the KlickyMart index") + "...");
    var get = src === "relays"
      ? pool().querySync(RELAYS, relayFilters(sub)[0]).then(function (a) { var fs = relayFilters(sub); return fs.length > 1 ? pool().querySync(RELAYS, fs[1]).then(function (b) { return a.concat(b); }) : a; })
          .then(function (evs) { return evs.filter(function (e) { return NT.verifyEvent(e); }); })
      : fetch("/feed.json?" + q(sub)).then(function (r) { return r.json(); }).then(function (j) { return j.items || []; });
    get.then(function (evs) {
      evs.sort(function (a, b) { return b.created_at - a.created_at; });
      var ol = $("km-feed"); ol.textContent = "";
      evs.slice(0, 100).forEach(function (ev) {
        var li = document.createElement("li"); li.dataset.pubkey = ev.pubkey;
        var h = document.createElement("div"); h.className = "km-muted";
        h.textContent = "kind " + ev.kind + " · " + new Date(ev.created_at * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC · " + NT.nip19.npubEncode(ev.pubkey).slice(0, 16) + "…";
        var body = document.createElement("p"); body.textContent = String(ev.content || "").slice(0, 600);
        li.appendChild(h); li.appendChild(body);
        if ([422, 421, 1].indexOf(ev.kind) !== -1 && window.KMTip) { var tb = document.createElement("button"); tb.type = "button"; tb.textContent = "Tip"; tb.addEventListener("click", function () { window.KMTip.open(ev.pubkey, ev.id, ev.kind); }); li.appendChild(tb); }
        ol.appendChild(li);
      });
      status(evs.length + " events (signatures verified).");
      badges(evs.map(function (e) { return e.pubkey; }));
    }).catch(function (e) { status("Feed failed: " + e.message); });
  }
  function badges(pks) {
    var uniq = pks.filter(function (p, i) { return pks.indexOf(p) === i; }).slice(0, 50);
    if (!uniq.length) return;
    fetch("/tip-ready.json?pubkeys=" + uniq.join(",")).then(function (r) { return r.json(); }).then(function (j) {
      (j.items || []).filter(function (t) { return t.tip_ready; }).forEach(function (t) {
        document.querySelectorAll("#km-feed li").forEach(function (li) {
          if (li.dataset.pubkey !== t.pubkey || li.querySelector(".km-tip-ready")) return;
          var a = document.createElement("a"); a.href = "/wallet#tip-ready"; a.className = "km-badge km-tip-ready"; a.textContent = "⚡ tip-ready";
          var rails = []; if (t.rails && t.rails.lightning) rails.push("⚡ Lightning"); if (t.rails && t.rails.cashu) rails.push("🥜 Cashu");
          a.textContent = "tip-ready: " + (rails.join(" + ") || "⚡");
          a.title = "Accepts tips via " + (rails.join(" and ") || "Lightning") + ". Display only; never affects ranking.";
          li.firstChild.appendChild(document.createTextNode(" ")); li.firstChild.appendChild(a);
        });
      });
    }).catch(function () { /* badges are optional */ });
  }
  fetch("/auth/me", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (j) { if (j.pubkey) status("Server session exists for " + NT.nip19.npubEncode(j.pubkey) + "; sign in again to use your signer in this tab."); }).catch(function () {});
})();
