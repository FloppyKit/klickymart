(function () {
  var canvas2d = document.getElementById("km-landscape");
  var canvasGl = document.getElementById("km-landscape-gl");
  if (!canvas2d || !(canvas2d instanceof HTMLCanvasElement)) return;

  var reach = clamp01(parseFloat(canvas2d.getAttribute("data-reach") || "0"));
  var btc = clamp01(parseFloat(canvas2d.getAttribute("data-btc") || "0"));
  var tierAttr = canvas2d.getAttribute("data-tier");
  var tierOverride = tierAttr != null && tierAttr !== "" ? parseInt(tierAttr, 10) : null;
  var params = new URLSearchParams(window.location.search);
  if (params.has("reach")) {
    var r = parseFloat(params.get("reach") || "");
    if (!Number.isNaN(r)) reach = clamp01(r);
  }
  if (params.has("btc")) {
    var b = parseFloat(params.get("btc") || "");
    if (!Number.isNaN(b)) btc = clamp01(b);
  }
  if (params.has("tier")) {
    var t = parseInt(params.get("tier") || "", 10);
    if (!Number.isNaN(t) && t >= 0 && t <= 3) tierOverride = t;
  }
  if (params.get("scene") === "1") {
    document.body.classList.add("km-scene-only");
  }
  var enableWebGL = params.get("gl") === "1";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var pauseMotion = params.get("nomotion") === "1" || reduced;
  var ctx = canvas2d.getContext("2d");
  if (!ctx) return;

  function clamp01(n) {
    return Math.max(0, Math.min(1, n));
  }

  function css(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function isLightTheme() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t === "light") return true;
    if (t === "dark") return false;
    return false;
  }

  function fidelity2d() {
    if (tierOverride != null && !Number.isNaN(tierOverride)) return tierOverride;
    return reach * 3;
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = window.innerWidth;
    var h = window.innerHeight;
    canvas2d.width = Math.floor(w * dpr);
    canvas2d.height = Math.floor(h * dpr);
    canvas2d.style.width = w + "px";
    canvas2d.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h };
  }

  function drawSky(w, h, light) {
    var horizon = h * (0.52 + reach * 0.04);
    var g = ctx.createLinearGradient(0, 0, 0, horizon);
    if (light) {
      g.addColorStop(0, css("--km-landscape-sky-top", "#8ec5f0"));
      g.addColorStop(0.55, css("--km-landscape-sky-mid", "#f5c4a8"));
      g.addColorStop(1, css("--km-landscape-sky-bot", "#e8a090"));
    } else {
      g.addColorStop(0, css("--km-landscape-sky-top", "#050510"));
      g.addColorStop(0.45, css("--km-landscape-sky-mid", "#12082a"));
      g.addColorStop(1, css("--km-landscape-sky-bot", "#2a1048"));
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    return horizon;
  }

  function drawSun(w, horizon, light) {
    var radius = w * (0.14 + btc * 0.26);
    var cx = w * 0.5;
    var cy = horizon + radius * (0.88 - btc * 1.02);
    var glowA = light ? 0.35 + btc * 0.35 : 0.45 + btc * 0.5;

    ctx.save();
    var rg = ctx.createRadialGradient(cx, cy, radius * 0.15, cx, cy, radius * 2.8);
    rg.addColorStop(0, "rgba(255,180,60," + glowA + ")");
    rg.addColorStop(0.35, "rgba(255,100,80," + (glowA * 0.65) + ")");
    rg.addColorStop(0.7, "rgba(255,40,120," + (glowA * 0.25) + ")");
    rg.addColorStop(1, "rgba(255,40,120,0)");
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 2.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (btc < 0.15) {
      ctx.save();
      ctx.strokeStyle = "#f7a128";
      ctx.lineWidth = 3 + reach * 2;
      ctx.shadowColor = "#ff9040";
      ctx.shadowBlur = 14;
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(cx, horizon + radius * 0.55, radius * 0.55, Math.PI * 1.08, Math.PI * 1.92);
      ctx.stroke();
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();

    var vg = ctx.createLinearGradient(cx, cy - radius, cx, cy + radius);
    vg.addColorStop(0, "#f7a128");
    vg.addColorStop(0.35, "#ff8c20");
    vg.addColorStop(0.65, "#ff5030");
    vg.addColorStop(1, "#e03090");
    ctx.fillStyle = vg;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

    var y = cy;
    var bottom = cy + radius;
    while (y < bottom) {
      var t = (y - cy) / radius;
      if (t < 0) t = 0;
      var gap = 1 + t * t * (6 + btc * 10);
      var stripe = 2 + t * (5 + btc * 8);
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,1)";
      ctx.fillRect(cx - radius - 2, y, radius * 2 + 4, gap);
      ctx.globalCompositeOperation = "source-over";
      y += gap + stripe;
    }
    ctx.restore();
  }

  function drawMountains(w, horizon, light) {
    var fid = fidelity2d();
    function hPx(frac) {
      return window.innerHeight * frac * (0.7 + reach * 0.3);
    }
    var peaks = [
      [0, horizon, w * 0.12, horizon - hPx(0.08), w * 0.22, horizon],
      [w * 0.18, horizon, w * 0.34, horizon - hPx(0.14), w * 0.5, horizon],
      [w * 0.42, horizon, w * 0.58, horizon - hPx(0.11), w * 0.72, horizon],
      [w * 0.65, horizon, w * 0.82, horizon - hPx(0.16), w, horizon],
    ];

    var fillA = Math.min(1, (fid / 3) * (light ? 0.35 : 0.55));
    if (fid < 0.8) fillA *= 0.15;
    var stroke = light ? "rgba(90,67,180,0.55)" : "rgba(180,120,255,0.7)";

    peaks.forEach(function (p) {
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(p[2], p[3]);
      ctx.lineTo(p[4], p[5]);
      ctx.closePath();
      if (fillA > 0.05) {
        ctx.fillStyle = light
          ? "rgba(90,67,180," + fillA + ")"
          : "rgba(40,20,80," + fillA + ")";
        ctx.fill();
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1 + reach * 1.5;
      ctx.globalAlpha = 0.35 + reach * 0.65;
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }

  function drawHorizonGlow(w, horizon, green, light) {
    ctx.save();
    ctx.strokeStyle = green;
    ctx.lineWidth = 2 + reach * 2;
    ctx.shadowColor = green;
    ctx.shadowBlur = 8 + reach * 16;
    ctx.globalAlpha = 0.65 + reach * 0.35;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.lineTo(w, horizon);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = light ? "rgba(255,120,180,0.35)" : "rgba(255,80,160,0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, horizon + 1);
    ctx.lineTo(w, horizon + 1);
    ctx.stroke();
    ctx.restore();
  }

  function drawHighway(w, h, horizon, scroll, green, light) {
    var vanishX = w * 0.5;
    var vanishY = horizon;
    var floorH = h - horizon;
    var roadW = 0.2 + reach * 0.05;

    ctx.save();
    ctx.fillStyle = light ? "rgba(18,22,28,0.82)" : "rgba(6,10,14,0.92)";
    ctx.beginPath();
    ctx.moveTo(vanishX, vanishY);
    ctx.lineTo(w * (0.5 + roadW), h);
    ctx.lineTo(w * (0.5 - roadW), h);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "rgba(240,240,255,0.75)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(vanishX, vanishY);
    ctx.lineTo(w * (0.5 - roadW * 0.92), h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(vanishX, vanishY);
    ctx.lineTo(w * (0.5 + roadW * 0.92), h);
    ctx.stroke();

    var dashes = 22 + Math.floor(reach * 14);
    for (var i = 0; i <= dashes; i++) {
      var z = (i / dashes + scroll) % 1;
      var depth = z * z;
      var y = vanishY + floorH * depth;
      var half = roadW * depth * w * 0.95;
      if (i % 2 === 0) {
        var dashLen = 6 + (1 - depth) * 22;
        ctx.fillStyle = "rgba(255,220,100,0.95)";
        ctx.fillRect(vanishX - 1.5, y, 3, dashLen);
      }
      ctx.strokeStyle = green;
      ctx.globalAlpha = 0.35 + (1 - depth) * 0.45;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(vanishX - half, y);
      ctx.lineTo(vanishX - half * 0.96, y + 3);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(vanishX + half, y);
      ctx.lineTo(vanishX + half * 0.96, y + 3);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawFloor(w, h, horizon, scroll, light) {
    var floorH = h - horizon;
    var fg = ctx.createLinearGradient(0, horizon, 0, h);
    if (light) {
      fg.addColorStop(0, "rgba(8,40,28," + (0.05 + reach * 0.08) + ")");
      fg.addColorStop(1, "rgba(4,16,12," + (0.12 + reach * 0.15) + ")");
    } else {
      fg.addColorStop(0, "rgba(2,12,8," + (0.15 + reach * 0.2) + ")");
      fg.addColorStop(1, "rgba(1,4,6,0.85)");
    }
    ctx.fillStyle = fg;
    ctx.fillRect(0, horizon, w, floorH);

    var vanishX = w * 0.5;
    var vanishY = horizon;
    var green = css("--km-landscape-grid", css("--km-accent", "#3df29a"));
    var lineA = 0.55 + reach * 0.55;
    var blur = 10 + reach * 14;

    ctx.lineCap = "round";
    ctx.strokeStyle = green;
    ctx.shadowColor = green;
    ctx.shadowBlur = blur;

    var cols = 16 + Math.floor(reach * 16);
    for (var c = 0; c <= cols; c++) {
      var t = c / cols;
      var x0 = t * w;
      ctx.globalAlpha = lineA * (0.5 + Math.abs(t - 0.5) * 0.55);
      ctx.lineWidth = 1.2 + reach * 1.2;
      ctx.beginPath();
      ctx.moveTo(x0, h);
      ctx.lineTo(vanishX, vanishY);
      ctx.stroke();
    }

    var rows = 14 + Math.floor(reach * 20);
    for (var r = 0; r <= rows; r++) {
      var z = (r / rows + scroll) % 1;
      var depth = z * z;
      var y = vanishY + floorH * depth;
      var spread = depth * w * 0.85;
      ctx.globalAlpha = lineA * (1 - depth * 0.35);
      ctx.lineWidth = 1 + (1 - depth) * (0.5 + reach);
      ctx.beginPath();
      ctx.moveTo(vanishX - spread, y);
      ctx.lineTo(vanishX + spread, y);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    drawHighway(w, h, horizon, scroll, green, light);
    drawHorizonGlow(w, horizon, green, light);

    var fid = fidelity2d();
    if (fid > 2.2) {
      ctx.fillStyle = light ? "rgba(120,140,180,0.08)" : "rgba(80,60,120,0.12)";
      ctx.fillRect(0, horizon, w, floorH * 0.55);
    }
  }

  // ---- Store at the end of the road + agent shoppers (2D tier) ----
  var dataTotal = parseInt(canvas2d.getAttribute("data-total") || "0", 10) || 0;
  var dataReachable = parseInt(canvas2d.getAttribute("data-reachable") || "0", 10) || 0;
  var dataPrivReach = parseInt(canvas2d.getAttribute("data-private-btc-reachable") || "0", 10) || 0;
  var reachOverride = params.has("reach") && !Number.isNaN(parseFloat(params.get("reach") || ""));
  var btcOverride = params.has("btc") && !Number.isNaN(parseFloat(params.get("btc") || ""));

  function shopperCounts() {
    var total = dataTotal || 250;
    var reachableN = reachOverride || !dataTotal ? Math.round(reach * total) : dataReachable;
    var n = Math.max(0, Math.min(8, Math.round(reachableN / 20)));
    var orange = btcOverride ? Math.round(btc * n) : Math.min(n, Math.ceil(dataPrivReach / 20));
    return { n: n, orange: orange };
  }

  function storeGeom(w, horizon) {
    var W = Math.max(84, Math.min(196, w * 0.13));
    var p = Math.max(1, Math.round(W / 64));
    W = Math.round(W / p) * p;
    var H = Math.round(W * 0.5 / p) * p;
    return { W: W, H: H, p: p, bx: Math.round(w * 0.5 - W * 0.5), by: Math.round(horizon - H) };
  }
  function drawStore(w, horizon, light) {
    var g = storeGeom(w, horizon);
    var W = g.W, H = g.H, p = g.p, bx = g.bx, by = g.by;
    var lit = 0.25 + reach * 0.75;
    ctx.save();

    // Gas canopy + two pumps, right of the building
    var cw = Math.round(W * 0.62), cx0 = bx + W + p * 3, ch = Math.round(H * 0.82);
    var ctop = horizon - ch;
    ctx.fillStyle = "#1a1530";
    ctx.fillRect(cx0 + p * 3, ctop + p * 3, p * 2, ch - p * 3);
    ctx.fillRect(cx0 + cw - p * 5, ctop + p * 3, p * 2, ch - p * 3);
    ctx.fillStyle = "#e9e4f2";
    ctx.fillRect(cx0, ctop, cw, p * 3);
    ctx.fillStyle = "#ff4f9a";
    ctx.fillRect(cx0, ctop + p * 2, cw, p);
    var dl = ctx.createLinearGradient(0, ctop + p * 3, 0, horizon);
    dl.addColorStop(0, "rgba(255,240,200," + (0.08 + reach * 0.32) + ")");
    dl.addColorStop(1, "rgba(255,240,200,0)");
    ctx.fillStyle = dl;
    ctx.fillRect(cx0 + p, ctop + p * 3, cw - p * 2, ch - p * 3);
    [0.3, 0.62].forEach(function (f) {
      var px = Math.round(cx0 + cw * f);
      var ph = p * 8;
      ctx.fillStyle = "#2a2346";
      ctx.fillRect(px, horizon - ph, p * 4, ph);
      ctx.fillStyle = "#c9c2e0";
      ctx.fillRect(px, horizon - ph, p * 4, p);
      ctx.fillStyle = reach > 0.3 ? "rgba(110,243,255," + lit + ")" : "#12101f";
      ctx.fillRect(px + p, horizon - ph + p * 2, p * 2, p * 2);
      ctx.fillStyle = "#0c0a16";
      ctx.fillRect(px + p * 4, horizon - ph + p * 3, p, p * 3);
    });

    // Building body, flat roof, sign band
    ctx.fillStyle = light ? "#2b2445" : "#1c1830";
    ctx.fillRect(bx, by, W, H);
    var signH = Math.round(H * 0.26 / p) * p;
    ctx.fillStyle = "#e9e4f2";
    ctx.fillRect(bx - p, by - p, W + p * 2, p);
    ctx.fillStyle = "#14112a";
    ctx.fillRect(bx - p, by, W + p * 2, signH);
    var fs = Math.max(8, Math.floor(signH * 0.72));
    ctx.font = "bold " + fs + "px ui-monospace, Menlo, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "#6ef3ff";
    ctx.shadowBlur = 2 + reach * 16;
    ctx.fillStyle = "rgba(110,243,255," + (0.3 + reach * 0.7) + ")";
    var label = "KLICKYMART";
    var tw = ctx.measureText(label).width;
    var sx = tw > W - p * 2 ? (W - p * 2) / tw : 1;
    ctx.save();
    ctx.translate(bx + W / 2, by + signH / 2 + p * 0.5);
    ctx.scale(sx, 1);
    ctx.fillText(label, 0, 0);
    ctx.restore();
    ctx.shadowBlur = 0;

    // Striped awning with a scalloped edge
    var ay = by + signH, ah = p * 3, stripes = 12, sw = (W + p * 2) / stripes;
    for (var i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 ? "#f4ead8" : "#ff4f9a";
      ctx.fillRect(Math.round(bx - p + i * sw), ay, Math.ceil(sw), ah);
      ctx.beginPath();
      ctx.arc(bx - p + i * sw + sw / 2, ay + ah, sw / 2, 0, Math.PI);
      ctx.fill();
    }
    // Big windows either side of the door; they light up with reach
    var wy = ay + ah + p * 2;
    var wh = horizon - wy - p;
    var doorW = Math.round(W * 0.14 / p) * p;
    var doorX = Math.round(bx + W / 2 - doorW / 2);
    var sideW = (W - doorW - p * 6) / 2;
    var paneW = (sideW - p * 2) / 3;
    var order = [2, 3, 1, 4, 0, 5];
    var litPanes = Math.round(reach * 6 + 0.15);
    for (var k = 0; k < 6; k++) {
      var idx = k % 3;
      var x = k < 3 ? bx + p * 2 + idx * (paneW + p) : doorX + doorW + p * 2 + idx * (paneW + p);
      var on = order.indexOf(k) < litPanes;
      ctx.fillStyle = "#0a0816";
      ctx.fillRect(Math.round(x) - p, wy - p, Math.round(paneW) + p * 2, wh + p);
      if (on) {
        ctx.shadowColor = "#ffe9a8";
        ctx.shadowBlur = 4 + reach * 10;
        ctx.fillStyle = "rgba(255,233,168," + (0.65 + reach * 0.35) + ")";
      } else {
        ctx.fillStyle = "#151231";
      }
      ctx.fillRect(Math.round(x), wy, Math.round(paneW), wh - p);
      ctx.shadowBlur = 0;
      if (on) {
        ctx.fillStyle = "rgba(160,110,60,0.45)";
        ctx.fillRect(Math.round(x), wy + Math.round(wh * 0.5), Math.round(paneW), p);
      }
    }
    ctx.fillStyle = "#0a0816";
    ctx.fillRect(doorX - p, wy - p, doorW + p * 2, horizon - wy + p);
    ctx.fillStyle = reach > 0.5 ? "rgba(255,233,168,0.55)" : "#151231";
    ctx.fillRect(doorX, wy, doorW, horizon - wy);
    ctx.fillStyle = "#c9c2e0";
    ctx.fillRect(doorX + doorW - p * 2, wy + Math.round((horizon - wy) / 2), p, p * 2);

    // Neon OPEN sign in the left window
    var openOn = Math.max(0, Math.min(1, (reach - 0.4) / 0.25));
    ctx.font = "bold " + Math.max(6, Math.floor(wh * 0.3)) + "px ui-monospace, Menlo, Consolas, monospace";
    var ox = bx + p * 2 + paneW * 1.5 + p;
    var oy = wy + wh * 0.26;
    if (openOn > 0) {
      ctx.shadowColor = "#ff3b6b";
      ctx.shadowBlur = 6 + openOn * 12;
      ctx.fillStyle = "rgba(255,90,120," + (0.4 + openOn * 0.6) + ")";
    } else {
      ctx.fillStyle = "rgba(120,60,80,0.55)";
    }
    ctx.fillText("OPEN", ox, oy);
    ctx.shadowBlur = 0;
    canvas2d.dataset.storeOpen = openOn > 0 ? "1" : "0";
    canvas2d.dataset.storeLitWindows = String(litPanes);

    if (reach > 0.15) {
      var pool = ctx.createRadialGradient(w / 2, horizon, 2, w / 2, horizon, W * 0.9);
      pool.addColorStop(0, "rgba(255,233,168," + (reach * 0.22) + ")");
      pool.addColorStop(1, "rgba(255,233,168,0)");
      ctx.fillStyle = pool;
      ctx.fillRect(w / 2 - W, horizon, W * 2, W * 0.5);
    }
    ctx.restore();
  }
  var SHOPPER_A = [
    ".....o......",
    ".....a......",
    "...hhhhh....",
    "..hhvhhhh...",
    "..hvhhhhh...",
    "..hhhhhhh...",
    "...hhhhh....",
    "....nnn.....",
    "..bbbbbbb...",
    ".rbbbbbbbr..",
    ".rbbbbbbbr..",
    ".rbbbbbbbGGG",
    "..bbbbbbbGGG",
    "...l...l.GGG",
    "...l...l....",
    "..ll...ll...",
  ];
  var SHOPPER_B = SHOPPER_A.slice(0, 13).concat(["....l.l..GGG", "....l.l.....", "...ll.ll...."]);

  function drawShopper(x, y, px, frame, orange, alpha) {
    var map = frame ? SHOPPER_B : SHOPPER_A;
    var pal = {
      o: orange ? "#ffb347" : "#6ef3ff",
      a: "#8c86a8",
      h: orange ? "#ffd29a" : "#cfd3ef",
      v: "#ffffff",
      n: "#5d577a",
      b: orange ? "#f7931a" : "#9aa0c8",
      r: orange ? "#c96f0c" : "#6f7499",
      G: "#c8a070",
      l: "#4a4466",
    };
    var ox = Math.round(x - 6 * px);
    var oy = Math.round(y - 16 * px);
    ctx.save();
    ctx.globalAlpha = alpha;
    if (orange) {
      ctx.shadowColor = "#f7931a";
      ctx.shadowBlur = 6 + px * 3;
    }
    for (var r = 0; r < map.length; r++) {
      for (var c = 0; c < map[r].length; c++) {
        var ch = map[r].charAt(c);
        if (ch === ".") continue;
        ctx.fillStyle = pal[ch];
        ctx.fillRect(ox + c * px, oy + r * px, px, px);
      }
    }
    ctx.restore();
  }

  function drawShoppers(w, h, horizon, t) {
    var counts = shopperCounts();
    canvas2d.dataset.shoppers = String(counts.n);
    canvas2d.dataset.shoppersOrange = String(counts.orange);
    if (!counts.n) return;
    var floorH = h - horizon;
    var roadW = 0.2 + reach * 0.05;
    var still = pauseMotion || reduced;
    for (var i = 0; i < counts.n; i++) {
      var side = i % 2 === 0 ? -1 : 1;
      var slot = Math.floor(i / 2);
      // Walk between the store (d=0.16) and just above the hero card (d=0.55).
      var span = 0.39;
      var base = 0.53 - slot * 0.095 - (side > 0 ? 0.047 : 0);
      var travel = still ? 0 : (t || 0) * 0.0000045;
      var d = 0.16 + ((((base - 0.16 - travel * span) % span) + span) % span);
      var depth = d * d;
      var y = horizon + floorH * depth;
      var x = w * 0.5 + side * (roadW * w * 0.95 * depth + 8 + 14 * depth);
      var px = Math.max(1, Math.round(1 + depth * 5));
      var alpha = Math.max(0, Math.min(1, (d - 0.16) / 0.06, (0.55 - d) / 0.02 + 0.2));
      var frame = still ? 0 : Math.floor((t || 0) / 420 + i) % 2;
      drawShopper(x, y, px, frame, i < counts.orange, alpha);
    }
  }

  var glActive = false;
  var running2d = false;
  var raf2d = 0;

  function drawFrame(t) {
    if (glActive) return;
    var size = resize();
    var w = size.w;
    var h = size.h;
    var light = isLightTheme();
    var scroll = pauseMotion ? 0 : ((t || 0) * 0.00012) % 1;

    ctx.clearRect(0, 0, w, h);
    var horizon = drawSky(w, h, light);
    // Mountains sit behind the sun; the store stands in front of it.
    drawMountains(w, horizon, light);
    drawSun(w, horizon, light);
    drawFloor(w, h, horizon, scroll, light);
    drawStore(w, horizon, light);
    drawShoppers(w, h, horizon, pauseMotion ? 0 : t);
    canvas2d.dataset.tier = String(Math.round(fidelity2d()));
    canvas2d.dataset.landscapeMode = glActive ? "hidden" : "2d";
    window.__kmLandscapeReady = true;
    window.__kmLandscape2dActive = !glActive;
    if (!glActive) window.__kmLandscapeWebGL = false;
  }

  function startAnim2d() {
    if (reduced || pauseMotion || running2d || glActive) return;
    running2d = true;
    function loop(ts) {
      drawFrame(ts);
      raf2d = requestAnimationFrame(loop);
    }
    raf2d = requestAnimationFrame(loop);
  }

  function boot2d() {
    drawFrame(0);
    if (!reduced) startAnim2d();
  }

  function tryWebGL() {
    if (!canvasGl || reduced) return;
    import("/km-landscape-webgl.js?v=8")
      .then(function (mod) {
        var mount = mod.mountLandscapeWebGL || mod.default;
        if (!mount) return;
        var res = mount({
          glCanvas: canvasGl,
          fallbackCanvas: canvas2d,
          reach: reach,
          btc: btc,
          tierOverride: tierOverride,
          reducedMotion: reduced,
          isLightTheme: isLightTheme,
        });
        if (res && res.ok) {
          glActive = true;
          running2d = false;
          cancelAnimationFrame(raf2d);
          canvas2d.classList.add("km-landscape-fallback-hidden");
          canvas2d.dataset.fallbackHidden = "1";
          window.__kmLandscape2dActive = false;
        }
      })
      .catch(function () {
        /* keep 2D fallback */
      });
  }

  function boot() {
    boot2d();
    if (!enableWebGL) {
      canvas2d.dataset.landscapeMode = "2d";
      window.__kmLandscape2dActive = true;
      window.__kmLandscapeWebGL = false;
      return;
    }
    if ("requestIdleCallback" in window) {
      requestIdleCallback(function () { tryWebGL(); }, { timeout: 400 });
    } else {
      setTimeout(tryWebGL, 50);
    }
  }

  if (!enableWebGL) {
    boot();
  } else if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          boot();
          io.disconnect();
        }
      });
    }, { rootMargin: "0px" });
    io.observe(canvas2d);
  } else {
    boot();
  }

  window.addEventListener("resize", function () {
    if (!glActive) drawFrame(reduced ? 0 : performance.now());
  });

  document.getElementById("km-theme-toggle")?.addEventListener("click", function () {
    setTimeout(function () {
      if (!glActive) drawFrame(reduced ? 0 : performance.now());
    }, 50);
  });
})();
