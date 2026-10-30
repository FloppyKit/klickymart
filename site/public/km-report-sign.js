/* KlickyMart /report: build, sign and publish a kind 422 shopping-experience note IN THIS BROWSER.
 * Secret keys never leave the page: they are not sent to klickymart.com (or anywhere), not logged, not stored
 * (nothing is kept in browser storage), and nothing is tracked. The only network calls are:
 *   GET  /report/template?<note fields>   (no key fields; see templateQuery)
 *   POST /reviews?dry_run=1               (the SIGNED event only; see publicEvent)
 *   WebSocket to relays the user picks     (the SIGNED event only, via nostr-tools SimplePool)
 * Signing: nostr-tools 2.17.0 (vendored, pinned with SRI) or a NIP-07 signer (window.nostr). */
(function () {
  "use strict";
  var NT = window.NostrTools;
  var KEY_FIELDS = /^(nsec|sk|seckey|secret|privkey|private_?key|key)$/i;
  /** The only fields of an event that ever leave the page. */
  function publicEvent(ev) {
    var out = { id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, kind: ev.kind, tags: ev.tags, content: ev.content, sig: ev.sig };
    var s = JSON.stringify(out);
    if (/nsec1[02-9ac-hj-np-z]{20,}/.test(s)) throw new Error("refusing to send: the event text contains an nsec");
    if (state.skHex && s.indexOf(state.skHex) !== -1) throw new Error("refusing to send: the event contains the secret key");
    return out;
  }
  /** Note fields for GET /report/template. Key fields are never included. */
  function templateQuery(fields) {
    var q = new URLSearchParams();
    Object.keys(fields).forEach(function (k) { if (!KEY_FIELDS.test(k) && fields[k] !== "" && fields[k] != null) q.set(k, fields[k]); });
    return q.toString();
  }
  var state = { sk: null, skHex: null, pk: null, mode: "create", perStore: {} };
  window.KMSign = { publicEvent: publicEvent, templateQuery: templateQuery }; // for tests; holds no key
  if (!NT || !document.getElementById("km-sign")) return;
  var $ = function (id) { return document.getElementById(id); };
  var hex = function (b) { return Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); };
  function say(id, msg, bad) { var el = $(id); el.textContent = msg; el.className = bad ? "km-bad" : "km-muted"; }
  function setKey(sk) { state.sk = sk; state.skHex = sk ? hex(sk) : null; state.pk = sk ? NT.getPublicKey(sk) : null; }
  // The new secret is hidden by default (masked field). "Show once" reveals it a single time; hiding it, or downloading it,
  // clears the field and revokes the download URL, so the secret is not left in the page.
  var pending = null;
  function clearNsec() {
    $("km-nsec").value = ""; $("km-nsec").type = "password"; $("km-nsec-box").hidden = true;
    var a = $("km-nsec-dl"); if (a.href && a.href.indexOf("blob:") === 0) URL.revokeObjectURL(a.href); a.removeAttribute("href");
    $("km-show-nsec").disabled = true; pending = null;
  }
  function showNsecOnce(sk, label) {
    pending = NT.nip19.nsecEncode(sk);
    $("km-nsec").type = "password"; $("km-nsec").value = pending; $("km-nsec-box").hidden = false; $("km-show-nsec").disabled = false;
    $("km-nsec-label").textContent = label;
    var blob = new Blob([pending + "\n"], { type: "text/plain" });
    var a = $("km-nsec-dl"); a.href = URL.createObjectURL(blob); a.download = label.replace(/[^a-z0-9.-]+/gi, "-") + ".nsec.txt";
  }
  $("km-show-nsec").onclick = function () { if (!pending) return; $("km-nsec").type = "text"; $("km-show-nsec").disabled = true; };
  $("km-nsec-dl").onclick = function () { if (!pending) return false; setTimeout(clearNsec, 1500); };
  $("km-hide-nsec").onclick = clearNsec;
  $("km-create").onclick = function () {
    var sk = NT.generateSecretKey(); setKey(sk); state.mode = "create";
    showNsecOnce(sk, "klickymart-agent-key");
    say("km-key-status", "Agent key created: " + NT.nip19.npubEncode(state.pk) + ". Save the nsec now; it is shown once and KlickyMart never sees it.");
  };
  $("km-use-nsec").onclick = function () {
    var v = $("km-paste").value.trim(); $("km-paste").value = "";
    try { var d = NT.nip19.decode(v); if (d.type !== "nsec") throw new Error(); setKey(d.data); state.mode = "nsec"; ownKeyLoaded(); say("km-key-status", "Using your key " + NT.nip19.npubEncode(state.pk) + " (kept in this page's memory only)."); }
    catch (e) { say("km-key-status", "That is not an nsec.", true); }
  };
  $("km-use-nip07").onclick = function () {
    if (!window.nostr) return say("km-key-status", "No NIP-07 signer (window.nostr) in this browser.", true);
    window.nostr.getPublicKey().then(function (pk) { setKey(null); state.pk = pk; state.mode = "nip07"; ownKeyLoaded(); say("km-key-status", "Using your NIP-07 signer: " + NT.nip19.npubEncode(pk)); });
  };
  // Key choice is explicit: per-store mode never silently replaces a pasted key or a NIP-07 signer.
  $("km-per-store").onchange = function () {
    if ($("km-per-store").checked && (state.mode === "nsec" || state.mode === "nip07"))
      say("km-key-status", "You loaded your own " + (state.mode === "nip07" ? "NIP-07 signer" : "key") + ". Notes will be signed with NEW per-store keys instead only if you keep this box ticked; untick it to sign with your own key.", true);
    if ($("km-per-store").checked) $("km-per-store").setAttribute("data-confirmed", "1"); else $("km-per-store").removeAttribute("data-confirmed");
  };
  function ownKeyLoaded() { if ($("km-per-store").checked) { $("km-per-store").checked = false; $("km-per-store").removeAttribute("data-confirmed"); } }
  function signerLabel(domain) {
    if ($("km-per-store").checked) return "a per-store key for " + domain;
    return state.mode === "nip07" ? "your NIP-07 signer" : state.mode === "nsec" ? "your pasted key" : state.mode === "create" ? "the agent key created here" : "no key";
  }
  function signer(domain) {
    if ($("km-per-store").checked && (state.mode === "nsec" || state.mode === "nip07") && !$("km-per-store").getAttribute("data-confirmed"))
      throw new Error("Per-store keys are ticked but you loaded your own " + (state.mode === "nip07" ? "NIP-07 signer" : "key") + ". Untick 'Per-store key' to sign with it, or tick it again to confirm new per-store keys.");
    if ($("km-per-store").checked) {
      if (!state.perStore[domain]) { var sk = NT.generateSecretKey(); state.perStore[domain] = sk; showNsecOnce(sk, "klickymart-" + domain + "-key"); }
      var s = state.perStore[domain];
      return function (ev) { return Promise.resolve(NT.finalizeEvent(ev, s)); };
    }
    if (state.mode === "nip07") return function (ev) { return window.nostr.signEvent(ev); };
    if (!state.sk) throw new Error("create or load a key first");
    return function (ev) { return Promise.resolve(NT.finalizeEvent(ev, state.sk)); };
  }
  function fields() {
    var f = {};
    Array.prototype.forEach.call(document.querySelectorAll("#km-sign [data-field]"), function (el) { f[el.getAttribute("data-field")] = el.value.trim(); });
    return f;
  }
  var signed = null, lastDomain = null, timer = null;
  // relays start empty; the three suggestions are one click each
  Array.prototype.forEach.call(document.querySelectorAll("[data-add-relay]"), function (b) {
    b.onclick = function () { var u = b.getAttribute("data-add-relay"), cur = $("km-relays").value.split(/[\s,]+/).filter(Boolean); if (cur.indexOf(u) < 0) cur.push(u); $("km-relays").value = cur.join(" "); cancelReview(); };
  });
  $("km-build").onclick = function () {
    var f = fields(); signed = null; $("km-signed").textContent = ""; cancelReview();
    fetch("/report/template?" + templateQuery(f)).then(function (r) { return r.json(); }).then(function (t) {
      if (t.error || !t.unsigned_event) throw new Error((t.error && t.error.message) || "template error");
      say("km-warn", "Signing with " + signerLabel(t.fields.domain) + ". " + ((t.warnings || []).join(" | ") || "No warnings. counts_toward_chart: " + t.fields.counts_toward_chart));
      lastDomain = t.fields.domain;
      return signer(t.fields.domain)(t.unsigned_event);
    }).then(function (ev) {
      signed = publicEvent(ev);
      $("km-signed").textContent = JSON.stringify(signed, null, 1);
    }).catch(function (e) { say("km-warn", String(e.message || e), true); });
  };
  $("km-dry").onclick = function () {
    if (!signed) return say("km-result", "Build and sign first.", true);
    fetch("/reviews?dry_run=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(publicEvent(signed)) })
      .then(function (r) { return r.text(); }).then(function (t) { say("km-result", "dry run: " + t); });
  };
  // Two steps, never one click: "Review" shows the exact relays and signed event; "Confirm publish" stays disabled until the
  // review box is ticked, and any change (new build, relay edit) cancels the review.
  var ALLOWED = ($("km-relays").getAttribute("data-allowed") || "").split(" ").filter(Boolean);
  var review = null;
  function cancelReview() { review = null; $("km-confirm-box").hidden = true; $("km-confirm-ok").checked = false; $("km-confirm-publish").disabled = true; }
  $("km-relays").oninput = cancelReview;
  $("km-publish").onclick = function () {
    cancelReview();
    if (!signed) return say("km-result", "Build and sign first.", true);
    var relays = $("km-relays").value.split(/[\s,]+/).filter(function (u) { return /^wss:\/\//.test(u); });
    var bad = relays.filter(function (u) { return ALLOWED.indexOf(u) < 0; });
    if (bad.length) return say("km-result", "This page may only connect to: " + ALLOWED.join(", ") + ". Not allowed: " + bad.join(", "), true);
    if (!relays.length) return say("km-result", "Pick at least one wss:// relay.", true);
    review = { relays: relays, ev: publicEvent(signed) };
    $("km-confirm-relays").textContent = relays.join("\n");
    $("km-confirm-event").textContent = JSON.stringify(review.ev, null, 1);
    $("km-confirm-box").hidden = false;
  };
  $("km-confirm-ok").onchange = function () { $("km-confirm-publish").disabled = !(review && $("km-confirm-ok").checked); };
  $("km-confirm-publish").onclick = function () {
    if (!review || !$("km-confirm-ok").checked) return say("km-result", "Review the relays and event, tick the box, then confirm.", true);
    var relays = review.relays, ev = review.ev; cancelReview();
    // Optional random delay (our timing advice: created_at is public, so publish hours or days after the purchase).
    var range = ($("km-delay").value || "0-0").split("-").map(Number), ms = Math.round((range[0] + Math.random() * (range[1] - range[0])) * 3600 * 1000);
    if (ms > 0) {
      var at = new Date(Date.now() + ms);
      say("km-result", "Scheduled: this page will re-sign the same note with the then-current time and publish it at about " + at.toLocaleString() + ". Keep this tab open. ");
      $("km-cancel-delay").hidden = false;
      timer = setTimeout(function () {
        timer = null; $("km-cancel-delay").hidden = true;
        var tmpl = { kind: ev.kind, created_at: Math.floor(Date.now() / 1000), tags: ev.tags, content: ev.content };
        Promise.resolve(signer(lastDomain)(tmpl)).then(function (fresh) { send(relays, publicEvent(fresh)); }).catch(function (e) { say("km-result", "Delayed publish failed: " + (e.message || e), true); });
      }, ms);
      return;
    }
    send(relays, ev);
  };
  $("km-cancel-delay").onclick = function () { if (timer) clearTimeout(timer); timer = null; $("km-cancel-delay").hidden = true; say("km-result", "Scheduled publish cancelled. Nothing was sent."); };
  function send(relays, ev) {
    var pool = new NT.SimplePool();
    Promise.allSettled(pool.publish(relays, ev)).then(function (rs) {
      say("km-result", "Published from your browser: " + rs.map(function (r, i) { return relays[i] + " " + (r.status === "fulfilled" ? "ok" : "failed (" + r.reason + ")"); }).join("; ") + ". Event id " + ev.id);
      pool.close(relays);
    });
  }
})();
