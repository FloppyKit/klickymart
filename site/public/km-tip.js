/* KlickyMart /app tipping: Lightning zaps (NIP-57), plain Lightning tips, and Cashu nutzaps (NIP-61), all in this browser.
 * KlickyMart never holds keys, funds, NWC strings or Cashu tokens. The server is asked only for a bolt11 (it fetches the
 * recipient's public LNURL-pay endpoint for you). Zap requests and nutzaps are signed by YOUR signer (window.KMAppSigner)
 * and nutzaps are published by this page only after you confirm. NWC strings stay in memory unless you opt in.
 * Remote text is inserted with textContent only. */
(function () {
  "use strict";
  var NT = window.NostrTools, CT = window.CashuTs;
  var ZAP_RELAYS = ["wss://relay.primal.net", "wss://nos.lol", "wss://relay.damus.io"];
  var NWC_KEY = "km.app.nwc";

  function buildZapRequest(o) {
    var tags = [["relays"].concat(o.relays || ZAP_RELAYS), ["amount", String(o.msat)], ["p", o.recipient]];
    if (o.e) tags.push(["e", o.e]); if (o.k != null) tags.push(["k", String(o.k)]);
    return { kind: 9734, created_at: o.now || Math.floor(Date.now() / 1000), content: o.comment || "", tags: tags };
  }
  /** NIP-61 kind 9321. proofs: serialized proof JSON strings (P2PK-locked to the recipient). */
  function buildNutzap(o) {
    var tags = o.proofs.map(function (p) { return ["proof", typeof p === "string" ? p : JSON.stringify(p)]; });
    tags.push(["unit", "sat"], ["u", o.mint], ["p", o.recipient]);
    if (o.e) tags.push(["e", o.e]); if (o.k != null) tags.push(["k", String(o.k)]);
    return { kind: 9321, created_at: o.now || Math.floor(Date.now() / 1000), content: o.comment || "", tags: tags };
  }
  function normMint(m) { return String(m || "").trim().toLowerCase().replace(/\/+$/, ""); }
  /** A token's mint must be listed by the recipient (10019) AND reachable under this page's CSP. */
  function mintAllowed(mint, recipientMints, allowed) {
    var m = normMint(mint);
    if (recipientMints.map(normMint).indexOf(m) === -1) return "the token's mint " + m + " is not one of the recipient's mints (" + recipientMints.join(", ") + ")";
    var origin; try { origin = new URL(m).origin; } catch (e) { return "bad mint URL"; }
    if (allowed.indexOf(origin) === -1) return "this page may only contact these mints: " + allowed.join(", ");
    return null;
  }
  function parseNwc(uri, allowedRelays) {
    var m = /^nostr\+walletconnect:\/\/([0-9a-f]{64})\?(.*)$/i.exec(String(uri || "").trim());
    if (!m) throw new Error("expected nostr+walletconnect://<64-hex>?relay=...&secret=...");
    var q = new URLSearchParams(m[2]); var relay = (q.get("relay") || "").replace(/\/+$/, ""); var secret = q.get("secret") || "";
    if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error("NWC secret missing");
    var origin = relay.replace(/^(wss?:\/\/[^/]+).*$/, "$1");
    if (allowedRelays.indexOf(origin) === -1) throw new Error("this page may only use these NWC relays: " + allowedRelays.join(", "));
    return { walletPubkey: m[1].toLowerCase(), relay: relay, secret: secret.toLowerCase() };
  }
  /** One-shot NWC session: pay_invoice only, only this invoice, only once; the connection is dropped afterwards. */
  function nwcSession(conn, invoice, expectedMsat, invoiceMsat) {
    var used = false;
    return { payInvoice: function (inv) {
      if (used) throw new Error("this NWC session already paid once");
      if (inv !== invoice) throw new Error("NWC session is limited to the invoice shown");
      if (invoiceMsat !== expectedMsat) throw new Error("invoice amount does not match the tip amount");
      used = true;
      return { method: "pay_invoice", params: { invoice: inv, amount: expectedMsat } };
    }, conn: conn };
  }
  window.KMTipLib = { buildZapRequest: buildZapRequest, buildNutzap: buildNutzap, mintAllowed: mintAllowed, parseNwc: parseNwc, nwcSession: nwcSession };
  var root = document.getElementById("km-tip");
  if (!root || !NT) return;

  var $ = function (id) { return document.getElementById(id); };
  var hexToBytes = function (h) { var a = new Uint8Array(h.length / 2); for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; };
  var ALLOWED_MINTS = (root.dataset.mints || "").split(" ").filter(Boolean);
  var NWC_RELAYS = (root.dataset.nwcRelays || "").split(" ").filter(Boolean);
  var t = { recipient: null, e: null, k: null, info: null, inv: null, pool: null };
  function status(m) { $("km-tip-status").textContent = m; }
  function pool() { return t.pool || (t.pool = new NT.SimplePool()); }
  function signer() { if (!window.KMAppSigner) throw new Error("sign in above first (your signer signs tips)"); return window.KMAppSigner; }
  $("km-tip-nwc-relays").textContent = NWC_RELAYS.join(", ");

  function open(pk, e, k) {
    if (!/^[0-9a-f]{64}$/.test(pk || "")) return;
    t.recipient = pk; t.e = /^[0-9a-f]{64}$/.test(e || "") ? e : null; t.k = k != null && k !== "" ? Number(k) : null; t.inv = null;
    root.hidden = false; $("km-tip-pay").hidden = true; $("km-tip-cashu").hidden = true;
    $("km-tip-to").textContent = NT.nip19.npubEncode(pk) + (t.e ? " (event " + t.e.slice(0, 12) + "…, kind " + t.k + ")" : " (profile)");
    $("km-tip-rails").textContent = "checking…";
    fetch("/tip-ready.json?pubkeys=" + pk).then(function (r) { return r.json(); }).then(function (j) {
      var x = (j.items || [])[0] || {}; t.info = x;
      var rails = []; if (x.rails && x.rails.lightning) rails.push("⚡ Lightning (" + x.addr + ")"); if (x.rails && x.rails.cashu) rails.push("🥜 Cashu");
      $("km-tip-rails").textContent = rails.length ? "accepts " + rails.join(" + ") : "no tip rails found";
      if (x.cashu) {
        $("km-tip-cashu").hidden = false;
        $("km-tip-cashu-status").textContent = "Recipient mints: " + x.cashu.mints.join(", ") + (x.cashu.mints_reachable_here.length ? "" : " (none reachable from this page)");
      } else {
        var c = $("km-tip-cashu-status"); c.textContent = "Not set up for Cashu. ";
        var a = document.createElement("a"); a.href = "/wallet#cashu-nutzaps"; a.textContent = "How to receive Cashu tips"; c.appendChild(a);
      }
    }).catch(function () { $("km-tip-rails").textContent = "could not check rails"; });
    root.scrollIntoView();
  }
  window.KMTip = { open: open, signerReady: function () { status(window.KMAppSigner ? "Signer ready for tips." : ""); } };

  // ---------- Lightning ----------
  $("km-tip-invoice").addEventListener("click", function () {
    var sats = Number($("km-tip-sats").value); if (!(sats >= 1 && sats <= 1e6)) { status("Amount must be 1 to 1,000,000 sats"); return; }
    var msat = sats * 1000, comment = $("km-tip-comment").value.slice(0, 280), zap = $("km-tip-zap").checked;
    var body = zap ? null : { recipient: t.recipient, amount_msat: msat, comment: comment };
    var p = zap ? (function () {
      var s = signer(); var tmpl = buildZapRequest({ recipient: t.recipient, e: t.e, k: t.k, msat: msat, comment: comment });
      if (!confirm("Sign a public zap request for " + sats + " sats? It reveals that you tipped this.")) throw new Error("cancelled");
      return s.sign(tmpl).then(function (ev) { if (!NT.verifyEvent(ev)) throw new Error("signer returned an invalid event"); return { zap_request: ev }; });
    })() : Promise.resolve(body);
    Promise.resolve(p).then(function (b) {
      status("Asking the recipient's wallet for an invoice…");
      return fetch("/tip/invoice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(function (r) { return r.json(); });
    }).then(function (j) {
      if (!j.ok) throw new Error((j.error && j.error.message) || "no invoice");
      if (j.amount_msat !== msat) throw new Error("server returned a different amount");
      t.inv = j; $("km-tip-pay").hidden = false; $("km-tip-bolt11").textContent = j.pr;
      $("km-tip-link").href = "lightning:" + j.pr;
      if (window.KMQR) { var q = window.KMQR(0, "M"); q.addData(("lightning:" + j.pr).toUpperCase(), "Alphanumeric"); q.make(); $("km-tip-qr").src = q.createDataURL(4, 8); }
      status("Invoice for " + sats + " sats to " + j.addr + ". Pay it with any option below." + (j.zap ? " Waiting for the zap receipt…" : ""));
      if (j.zap) watchReceipt(j);
    }).catch(function (e) { status("Tip failed: " + (e && e.message || String(e))); });
  });
  $("km-tip-webln").addEventListener("click", function () {
    if (!window.webln) { status("No WebLN wallet found (window.webln)"); return; }
    window.webln.enable().then(function () { return window.webln.sendPayment(t.inv.pr); })
      .then(function () { status("Paid with WebLN." + (t.inv.zap ? " Waiting for the zap receipt…" : "")); }).catch(function (e) { status("WebLN: " + e.message); });
  });
  try { if (localStorage.getItem(NWC_KEY)) $("km-tip-nwc").placeholder = "saved connection will be used"; } catch (e) { /* */ }
  $("km-tip-nwc-pay").addEventListener("click", function () {
    var raw = $("km-tip-nwc").value.trim() || (function () { try { return localStorage.getItem(NWC_KEY) || ""; } catch (e) { return ""; } })();
    $("km-tip-nwc").value = "";
    var conn; try { conn = parseNwc(raw, NWC_RELAYS); } catch (e) { status(e.message); return; }
    if ($("km-tip-nwc-persist").checked && confirm("Store this NWC string in localStorage? Anyone with this browser profile could spend up to its budget.")) localStorage.setItem(NWC_KEY, raw);
    var sess = nwcSession(conn, t.inv.pr, t.inv.amount_msat, t.inv.amount_msat);
    var req; try { req = sess.payInvoice(t.inv.pr); } catch (e) { status(e.message); return; }
    if (!confirm("Pay " + t.inv.amount_msat / 1000 + " sats from your NWC wallet?")) return;
    var sk = hexToBytes(conn.secret); var me = NT.getPublicKey(sk);
    Promise.resolve(NT.nip04.encrypt(sk, conn.walletPubkey, JSON.stringify(req))).then(function (ct) {
      var ev = NT.finalizeEvent({ kind: 23194, created_at: Math.floor(Date.now() / 1000), tags: [["p", conn.walletPubkey]], content: ct }, sk);
      var sub = pool().subscribeMany([conn.relay], [{ kinds: [23195], authors: [conn.walletPubkey], "#p": [me], "#e": [ev.id] }], { onevent: function (r) {
        if (!NT.verifyEvent(r)) return;
        Promise.resolve(NT.nip04.decrypt(sk, conn.walletPubkey, r.content)).then(function (pt) { var j = JSON.parse(pt); sub.close(); sk = null; status(j.error ? "NWC wallet refused: " + j.error.message : "Paid via NWC." + (t.inv.zap ? " Waiting for the zap receipt…" : "")); });
      } });
      return Promise.any(pool().publish([conn.relay], ev));
    }).catch(function (e) { status("NWC: " + e.message); });
  });
  function watchReceipt(inv) {
    var id = inv.zap_request_id, done = false, n = 0;
    var since = Math.floor(Date.now() / 1000) - 60;
    var sub = pool().subscribeMany(ZAP_RELAYS, [{ kinds: [9735], "#p": [t.recipient], since: since }], { onevent: function (r) {
      if (done || !NT.verifyEvent(r)) return;
      var d = (r.tags.find(function (x) { return x[0] === "description"; }) || [])[1] || ""; var req; try { req = JSON.parse(d); } catch (e) { return; }
      if (req.id === id) show(r, r.pubkey === inv.zapper_pubkey, "relays");
    } });
    function show(r, validated, via) { if (done) return; done = true; sub.close(); status("Zap receipt " + r.id.slice(0, 12) + "… arrived via " + via + (validated ? " (signed by the recipient's LNURL zap key)" : " (unverified signer)") + "."); }
    (function poll() {
      if (done || n++ > 24) { if (!done) sub.close(); return; }
      fetch("/tip/receipt?zap_request=" + id + "&zapper=" + inv.zapper_pubkey).then(function (r) { return r.json(); }).then(function (j) { if (j.found) show(j.receipt, j.validated, "KlickyMart ingest"); }).catch(function () {});
      setTimeout(poll, 5000);
    })();
  }

  // ---------- Cashu ----------
  $("km-tip-nutzap").addEventListener("click", function () {
    var x = t.info && t.info.cashu; if (!x) { status("Recipient is not set up for Cashu."); return; }
    if (!CT) { status("Cashu library failed to load."); return; }
    var token = $("km-tip-token").value.trim(); var sats = Number($("km-tip-sats").value);
    var mint; try { mint = normMint(CT.getTokenMetadata(token).mint); } catch (e) { status("Not a Cashu token: " + e.message); return; }
    var why = mintAllowed(mint, x.mints, ALLOWED_MINTS); if (why) { status(why); return; }
    var s; try { s = signer(); } catch (e) { status(e.message); return; }
    if (!confirm("Swap " + sats + " sats of this token at " + mint + " into ecash locked to the recipient? Your token is spent; you will get a change token.")) return;
    var w = new CT.Wallet(mint); var locked, change;
    status("Swapping at " + mint + "…");
    w.loadMint().then(function () {
      var dec = w.decodeToken(token);
      return w.ops.send(sats, dec.proofs).asP2PK({ pubkey: x.p2pk }).run();
    }).then(function (res) {
      $("km-tip-token").value = "";
      locked = CT.serializeProofs(res.send); change = res.keep && res.keep.length ? CT.getEncodedToken({ mint: mint, proofs: res.keep }) : "";
      $("km-tip-change").textContent = change ? "Your change (save it now, it is money): " + change : "No change.";
      return s.sign(buildNutzap({ recipient: t.recipient, e: t.e, k: t.k, mint: mint, proofs: locked, comment: $("km-tip-comment").value.slice(0, 280) }));
    }).then(function (ev) {
      if (!NT.verifyEvent(ev)) throw new Error("signer returned an invalid event");
      var relays = x.relays.filter(function (r) { return ZAP_RELAYS.indexOf(r) !== -1; });
      if (!relays.length) relays = ZAP_RELAYS;
      if (!confirm("Publish this nutzap (kind 9321) to " + relays.join(", ") + "? It is public; the recipient redeems it.")) {
        $("km-tip-change").textContent += " Locked (unpublished) nutzap event: " + JSON.stringify(ev); status("Not published. The locked ecash is in the event above; only the recipient can spend it."); return;
      }
      return Promise.allSettled(pool().publish(relays, ev)).then(function (rs) { status("Nutzap published to " + rs.filter(function (r) { return r.status === "fulfilled"; }).length + " of " + relays.length + " relays."); });
    }).catch(function (e) { status("Cashu tip failed: " + e.message + (locked ? " Locked proofs: " + JSON.stringify(locked) : "")); });
  });

  var qp = new URLSearchParams(location.search);
  if (qp.get("tip")) open(qp.get("tip").toLowerCase(), qp.get("e"), qp.get("k"));
})();
