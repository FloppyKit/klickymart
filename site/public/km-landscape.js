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
      // dawn glint: clip to the sky so nothing bleeds through the translucent floor
      ctx.beginPath();
      ctx.rect(0, 0, w, horizon - 1);
      ctx.clip();
      ctx.beginPath();
      ctx.arc(cx, horizon + radius * 0.35, radius * 0.55, Math.PI * 1.08, Math.PI * 1.92);
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

  // ---- Pixel-art helpers: sprites are painted at 1 logical px, then scaled up crisp ----
  var FONT = {
    K: ["1.1", "1.1", "11.", "1.1", "1.1"],
    L: ["1..", "1..", "1..", "1..", "111"],
    I: ["111", ".1.", ".1.", ".1.", "111"],
    C: [".11", "1..", "1..", "1..", ".11"],
    Y: ["1.1", "1.1", ".1.", ".1.", ".1."],
    M: ["1...1", "11.11", "1.1.1", "1...1", "1...1"],
    A: [".1.", "1.1", "111", "1.1", "1.1"],
    R: ["11.", "1.1", "11.", "1.1", "1.1"],
    T: ["111", ".1.", ".1.", ".1.", ".1."],
    O: [".11.", "1..1", "1..1", "1..1", ".11."],
    P: ["11.", "1.1", "11.", "1..", "1.."],
    E: ["111", "1..", "11.", "1..", "111"],
    N: ["1..1", "11.1", "1.11", "1..1", "1..1"],
  };
  function textWidth(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) n += FONT[s[i]][0].length + (i ? 1 : 0);
    return n;
  }
  function pixText(c, s, x, y, color, rows) {
    c.fillStyle = color;
    for (var i = 0; i < s.length; i++) {
      var g = FONT[s[i]];
      for (var r = 0; r < (rows || 5); r++) for (var k = 0; k < g[r].length; k++) if (g[r][k] === "1") c.fillRect(x + k, y + r, 1, 1);
      x += g[0].length + 1;
    }
  }
  function offscreen(w, h) {
    var c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  // Logical store sprite: side wall (6) + front (66) + gap (3) + canopy (36); ground at row SH-1.
  var SW = 111, SH = 50, SIDE = 6, FRONT = 66, CAN_X = SIDE + FRONT + 3, CAN_W = 36;
  var storeCache = { key: "", canvas: null };

  function buildStoreSprite(lit, litPanes, openOn, light) {
    var cv = offscreen(SW, SH);
    var c = cv.getContext("2d");
    function R(x, y, w, h, col) { c.fillStyle = col; c.fillRect(x, y, w, h); }
    var G = SH - 1; // ground row
    var fx = SIDE, top = 4; // front face x, roof top
    var wall = light ? "#3a3160" : "#2a2350";
    var wallHi = light ? "#4a4078" : "#3a3168";
    var wallLo = light ? "#2a2348" : "#1b1636";

    // Side wall in perspective (receding to the left/back)
    for (var i = 0; i < SIDE; i++) {
      var yTop = top + 2 + Math.round(((SIDE - i) / SIDE) * 3);
      R(i, yTop, 1, G - yTop, wallLo);
      R(i, yTop, 1, 1, "#8f86b8");
    }
    R(1, top + 22, 3, 4, "#0d0b1c"); // side window
    R(1, top + 22, 3, 1, "rgba(255,233,168," + (0.15 + lit * 0.5) + ")");
    R(1, G - 2, SIDE, 2, "#151229");

    // Parapet / flat roof edge with highlight and shadow rows
    R(fx - 1, top, FRONT + 2, 1, "#f4f0ff");
    R(fx - 1, top + 1, FRONT + 2, 1, "#c9c2e0");
    R(fx - 1, top + 2, FRONT + 2, 1, "#8a82aa");
    // Rooftop details: AC box + vent, give a silhouette
    R(fx + 6, top - 3, 8, 3, "#6d6690"); R(fx + 6, top - 3, 8, 1, "#a39cc4"); R(fx + 8, top - 2, 1, 1, "#3b3560"); R(fx + 10, top - 2, 1, 1, "#3b3560");
    R(fx + FRONT - 10, top - 2, 3, 2, "#6d6690"); R(fx + FRONT - 11, top - 3, 5, 1, "#a39cc4");

    // Sign band
    var sy = top + 3, sh = 11;
    R(fx, sy, FRONT, sh, "#120f2a");
    R(fx, sy, FRONT, 1, "#2c2558");
    R(fx + 1, sy + 1, FRONT - 2, 1, "rgba(110,243,255," + (0.25 + lit * 0.55) + ")");
    R(fx + 1, sy + sh - 2, FRONT - 2, 1, "rgba(110,243,255," + (0.25 + lit * 0.55) + ")");
    var label = "KLICKYMART", tw = textWidth(label);
    var tx = fx + Math.floor((FRONT - tw) / 2), ty = sy + 3;
    pixText(c, label, tx, ty + 1, "#05343c"); // drop shadow
    var a = 0.45 + lit * 0.55;
    pixText(c, label, tx, ty, "rgba(110,243,255," + a + ")");
    // hot-white core on the top row of each glyph when bright
    if (lit > 0.5) {
      pixText(c, label, tx, ty, "rgba(230,255,255," + ((lit - 0.5) * 1.6) + ")", 1);
    }
    // little star bullets either side of the name
    R(fx + 5, sy + 5, 1, 1, "#ff4f9a"); R(fx + 4, sy + 5, 3, 1, "rgba(255,79,154,0.6)"); R(fx + 5, sy + 4, 1, 3, "rgba(255,79,154,0.6)");
    R(fx + FRONT - 6, sy + 5, 1, 1, "#ff4f9a"); R(fx + FRONT - 7, sy + 5, 3, 1, "rgba(255,79,154,0.6)"); R(fx + FRONT - 6, sy + 4, 1, 3, "rgba(255,79,154,0.6)");

    // Facade below sign
    var fy = sy + sh;
    R(fx, fy, FRONT, G - fy, wall);
    R(fx, fy, 1, G - fy, wallHi);
    R(fx + FRONT - 1, fy, 1, G - fy, wallLo);

    // Awning: stripes, highlight row, scalloped edge, shadow
    var ay = fy, ah = 4;
    for (var x = fx - 1; x < fx + FRONT + 1; x++) {
      var s = Math.floor((x - fx + 1) / 4) % 2;
      var col = s ? "#f4ead8" : "#ff4f9a";
      var dark = s ? "#cdbfa8" : "#c0306f";
      R(x, ay, 1, ah, col);
      R(x, ay, 1, 1, s ? "#ffffff" : "#ff8cc0");
      R(x, ay + ah - 1, 1, 1, dark);
      if ((x - fx + 1) % 4 === 1 || (x - fx + 1) % 4 === 2) R(x, ay + ah, 1, 1, dark);
    }
    R(fx, ay + ah + 1, FRONT, 1, wallLo);

    // Windows + door
    var wy = ay + ah + 3, wb = G - 4; // window top/bottom
    var doorW = 12, doorX = fx + Math.floor((FRONT - doorW) / 2);
    var paneW = 7;
    var panes = [];
    for (var k = 0; k < 3; k++) panes.push(fx + 3 + k * (paneW + 1));
    for (k = 0; k < 3; k++) panes.push(doorX + doorW + 2 + k * (paneW + 1));
    var order = [2, 3, 1, 4, 0, 5];
    // window frames
    R(panes[0] - 1, wy - 1, 3 * (paneW + 1) + 1, wb - wy + 2, "#0b0918");
    R(panes[3] - 1, wy - 1, 3 * (paneW + 1) + 1, wb - wy + 2, "#0b0918");
    var shelfCols = ["#ff4f9a", "#6ef3ff", "#3df29a", "#f7a128", "#c9c2e0"];
    for (k = 0; k < 6; k++) {
      var px0 = panes[k], on = order.indexOf(k) < litPanes;
      var ph = wb - wy;
      if (on) {
        R(px0, wy, paneW, ph, "#ffe9a8");
        R(px0, wy, paneW, 2, "#fff6d6");
        R(px0, wy + ph - 3, paneW, 3, "#f0cf80");
      } else {
        R(px0, wy, paneW, ph, "#17133a");
        R(px0, wy, paneW, 1, "#221d4e");
      }
      // shelf silhouettes with products
      for (var sr = 0; sr < 3; sr++) {
        var ly = wy + 5 + sr * 4;
        if (ly >= wb - 1) break;
        R(px0, ly, paneW, 1, on ? "#8a6a3c" : "#0e0b24");
        for (var pi = 0; pi < paneW; pi += 2) {
          var pc = shelfCols[(pi + sr * 2 + k) % shelfCols.length];
          R(px0 + pi, ly - 2, 1, 2, on ? pc : "#100d28");
        }
      }
      // glass glint
      R(px0 + 1, wy + 1, 1, 3, on ? "rgba(255,255,255,0.8)" : "rgba(140,130,200,0.25)");
    }
    // posters taped in windows
    R(panes[2] + 1, wy + 1, 5, 4, "#ff4f9a"); R(panes[2] + 2, wy + 2, 3, 1, "#fff"); R(panes[2] + 2, wy + 3, 2, 1, "#ffd0e4");
    R(panes[3] + 1, wy + 1, 5, 4, "#3df29a"); R(panes[3] + 3, wy + 2, 1, 2, "#0b3a26"); R(panes[3] + 2, wy + 2, 3, 1, "#0b3a26");
    R(panes[5] + 1, wy + 1, 5, 4, "#f7a128"); R(panes[5] + 2, wy + 2, 3, 2, "#7a3d00");
    // glass door
    R(doorX - 1, wy - 1, doorW + 2, G - wy + 1, "#c9c2e0");
    R(doorX, wy, doorW, G - wy, "#0b0918");
    var doorLit = litPanes >= 3;
    R(doorX + 1, wy + 1, doorW / 2 - 1, G - wy - 1, doorLit ? "#ffe0a0" : "#1a1640");
    R(doorX + doorW / 2 + 1, wy + 1, doorW / 2 - 2, G - wy - 1, doorLit ? "#ffe0a0" : "#1a1640");
    R(doorX + 2, wy + 2, 1, 4, "rgba(255,255,255,0.7)");
    R(doorX + doorW / 2 - 2, wy + 9, 1, 3, "#e9e4f2"); R(doorX + doorW / 2 + 2, wy + 9, 1, 3, "#e9e4f2");
    R(doorX + 2, wy + 6, doorW - 4, 1, doorLit ? "#c08a40" : "#2a2350"); // push bar
    // kickplate bricks + curb
    for (x = fx; x < fx + FRONT; x++) if (x < doorX - 1 || x > doorX + doorW) {
      R(x, wb + 1, 1, 3, (x % 4 === 0) ? wallLo : "#4a2a4a");
    }
    R(fx - 1, G - 0, FRONT + 2, 1, "#6d6690");
    R(fx, wb + 1, FRONT, 1, "#5e3658");

    // Neon OPEN sign hanging in the left window (2 px tube with dark backing)
    var ow = textWidth("OPEN"), ox = panes[0] + Math.floor((3 * (paneW + 1) - ow) / 2), oy = wy + 6;
    R(ox - 2, oy - 2, ow + 4, 9, "#1a0610");
    R(ox - 2, oy - 2, ow + 4, 1, "#3a1424");
    if (openOn > 0) {
      pixText(c, "OPEN", ox, oy, "rgba(255,70,110," + (0.45 + openOn * 0.55) + ")");
      if (openOn > 0.6) {
        pixText(c, "OPEN", ox, oy, "rgba(255,220,230," + (openOn - 0.4) + ")", 1);
      }
    } else {
      pixText(c, "OPEN", ox, oy, "#4a2234");
    }

    // ---- Gas canopy + pumps ----
    var cx0 = CAN_X, cTop = top + 14, cH = 5;
    R(cx0 + 4, cTop + cH, 2, G - cTop - cH, "#2a2346"); R(cx0 + 4, cTop + cH, 1, G - cTop - cH, "#4a4270");
    R(cx0 + CAN_W - 6, cTop + cH, 2, G - cTop - cH, "#2a2346"); R(cx0 + CAN_W - 6, cTop + cH, 1, G - cTop - cH, "#4a4270");
    R(cx0, cTop, CAN_W, cH, "#e9e4f2");
    R(cx0, cTop, CAN_W, 1, "#ffffff");
    R(cx0, cTop + 2, CAN_W, 2, "#ff4f9a");
    R(cx0, cTop + 3, CAN_W, 1, "#c0306f");
    R(cx0 + 1, cTop + cH, CAN_W - 2, 1, "rgba(255,246,214," + (0.3 + lit * 0.7) + ")"); // underside lights
    [9, 21].forEach(function (off) {
      var px = cx0 + off, py = G - 11;
      R(px - 1, G - 1, 8, 1, "#3b3560"); // island
      R(px, py, 6, 10, "#2e2650");
      R(px, py, 6, 1, "#c9c2e0");
      R(px + 5, py + 1, 1, 9, "#1c1736");
      R(px + 1, py + 2, 4, 3, reach > 0.3 ? "rgba(110,243,255," + (0.4 + lit * 0.6) + ")" : "#12101f");
      R(px + 1, py + 6, 4, 1, "#ff4f9a");
      R(px + 6, py + 3, 1, 5, "#0c0a16"); R(px + 7, py + 7, 1, 2, "#0c0a16"); // hose
    });
    // price board on a post at the far right (no brand, just a glyph)
    R(cx0 + CAN_W - 2, G - 22, 1, 22, "#3b3560");
    R(cx0 + CAN_W - 5, G - 27, 7, 6, "#120f2a");
    R(cx0 + CAN_W - 5, G - 27, 7, 1, "#c9c2e0");
    R(cx0 + CAN_W - 4, G - 25, 2, 1, "rgba(61,242,154," + (0.4 + lit * 0.6) + ")");
    R(cx0 + CAN_W - 4, G - 23, 4, 1, "rgba(247,161,40," + (0.4 + lit * 0.6) + ")");
    return cv;
  }

  function storeGeom(w, horizon) {
    // integer pixel scale: ~2 on phones, 3 on laptops, 4 on wide screens
    var p = w < 520 ? 2 : w < 1500 ? 3 : 4;
    var W = SW * p, H = SH * p;
    var frontCx = (SIDE + FRONT / 2) * p;
    return { W: W, H: H, p: p, bx: Math.round(w * 0.5 - frontCx), by: Math.round(horizon - H + p) };
  }

  function drawStore(w, horizon, light) {
    var g = storeGeom(w, horizon);
    var lit = 0.25 + reach * 0.75;
    var litPanes = Math.max(0, Math.min(6, Math.round(reach * 6 + 0.15)));
    var openOn = Math.max(0, Math.min(1, (reach - 0.4) / 0.25));
    var key = [lit.toFixed(2), litPanes, openOn.toFixed(2), light ? 1 : 0].join("|");
    if (storeCache.key !== key) {
      storeCache.key = key;
      storeCache.canvas = buildStoreSprite(lit, litPanes, openOn, light);
    }
    var p = g.p;
    ctx.save();
    // sign glow behind the sprite
    var signCx = g.bx + (SIDE + FRONT / 2) * p, signCy = g.by + 12 * p;
    var sg = ctx.createRadialGradient(signCx, signCy, 2, signCx, signCy, FRONT * p * 0.7);
    sg.addColorStop(0, "rgba(110,243,255," + (0.05 + reach * 0.3) + ")");
    sg.addColorStop(1, "rgba(110,243,255,0)");
    ctx.fillStyle = sg;
    ctx.fillRect(signCx - FRONT * p, signCy - FRONT * p, FRONT * p * 2, FRONT * p * 2);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(storeCache.canvas, g.bx, g.by, g.W, g.H);
    ctx.globalCompositeOperation = "lighter";
    // soft neon bloom on the sign band and OPEN sign
    ctx.globalAlpha = 0.06 + reach * 0.16;
    ctx.fillStyle = "rgb(110,243,255)";
    ctx.fillRect(g.bx + (SIDE + 1) * p, g.by + 8 * p, (FRONT - 2) * p, 9 * p);
    ctx.globalAlpha = 1;
    if (openOn > 0) {
      var og = ctx.createRadialGradient(g.bx + 18 * p, g.by + 31 * p, 1, g.bx + 18 * p, g.by + 31 * p, 16 * p);
      og.addColorStop(0, "rgba(255,60,110," + (openOn * 0.45) + ")");
      og.addColorStop(1, "rgba(255,60,110,0)");
      ctx.fillStyle = og;
      ctx.fillRect(g.bx, g.by + 15 * p, 36 * p, 32 * p);
    }
    // forecourt light spill: trapezoid from the storefront fanning toward the viewer
    if (reach > 0.12) {
      var gy = horizon + 1;
      var fl = g.bx + SIDE * p, fr = fl + FRONT * p;
      var depthPx = Math.min(70, 18 + reach * 50) * (p / 3);
      var spill = ctx.createLinearGradient(0, gy, 0, gy + depthPx);
      spill.addColorStop(0, "rgba(255,226,150," + (reach * 0.42) + ")");
      spill.addColorStop(1, "rgba(255,226,150,0)");
      ctx.fillStyle = spill;
      ctx.beginPath();
      ctx.moveTo(fl + 2 * p, gy);
      ctx.lineTo(fr - 2 * p, gy);
      ctx.lineTo(fr + depthPx * 0.9, gy + depthPx);
      ctx.lineTo(fl - depthPx * 0.9, gy + depthPx);
      ctx.closePath();
      ctx.fill();
      var cl = g.bx + CAN_X * p, cr = cl + CAN_W * p;
      var cs = ctx.createLinearGradient(0, gy, 0, gy + depthPx * 0.6);
      cs.addColorStop(0, "rgba(255,246,214," + (reach * 0.3) + ")");
      cs.addColorStop(1, "rgba(255,246,214,0)");
      ctx.fillStyle = cs;
      ctx.beginPath();
      ctx.moveTo(cl + 3 * p, gy);
      ctx.lineTo(cr - 3 * p, gy);
      ctx.lineTo(cr + depthPx * 0.5, gy + depthPx * 0.6);
      ctx.lineTo(cl - depthPx * 0.2, gy + depthPx * 0.6);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    canvas2d.dataset.storeOpen = openOn > 0 ? "1" : "0";
    canvas2d.dataset.storeLitWindows = String(litPanes);
  }

  // ---- Bot shoppers: 13x18 logical sprites, front (leaving with a bag) and back (heading in with a basket) ----
  // o antenna tip, a stem, H outline, h head, s head highlight, v visor, e eye, b body, d body shade, k chest light,
  // r arm, l leg, f foot, g bag, G bag shade, w handle, c basket
  var BOT_FRONT_TOP = [
    "......o......",
    "......a......",
    "..HHHHHHHHH..",
    "..HsshhhhhH..",
    "..HvvvvvvvH..",
    "..HveevveeH..",
    "..HvvvvvvvH..",
    "..HhhhhhhhH..",
    "..HHHHHHHHH..",
    ".....HdH.....",
    "..rbbbbbbbr..",
    "..rbbbkbbbrw.",
    "..rbbbbbbbgGg",
    "...ddddddd.gG",
  ];
  var BOT_BACK_TOP = [
    "......o......",
    "......a......",
    "..HHHHHHHHH..",
    "..HsshhhhhH..",
    "..HhhhhhhhH..",
    "..HhdhdhdhH..",
    "..HhhhhhhhH..",
    "..HhhhhhhhH..",
    "..HHHHHHHHH..",
    ".....HdH.....",
    "c.rbbbbbbbr..",
    "cccbdddddbr..",
    "cccbdbdbdbr..",
    "ccc.ddddddd..",
  ];
  var BOT_LEGS = [
    ["...l....l....", "...l....l....", "..ff....ff..."], // stand / contact
    ["....l..l.....", "....l..l.....", "...ff.ff....."], // passing (bob)
    ["..l......l...", "..l.....l....", ".ff.....ff..."], // stride
    ["....l..l.....", "....l..l.....", "...ff.ff....."],
  ];
  var botCache = {};
  function botSprite(facing, frame, orange) {
    var key = facing + frame + (orange ? "o" : "g");
    if (botCache[key]) return botCache[key];
    var pal = orange
      ? { o: "#ffd27a", a: "#8c86a8", H: "#3a1d06", h: "#ffb347", s: "#ffe2b0", v: "#2a1404", e: "#fff3c4", b: "#f7931a", d: "#b8620a", k: "#fff3c4", r: "#c96f0c", l: "#4a2a10", f: "#2a1404", g: "#f4ead8", G: "#c8b898", w: "#8c86a8", c: "#c9c2e0" }
      : { o: "#6ef3ff", a: "#8c86a8", H: "#262245", h: "#c3c7e3", s: "#eef0ff", v: "#14122a", e: "#6ef3ff", b: "#9aa0c8", d: "#6a6f96", k: "#6ef3ff", r: "#7d82aa", l: "#3c3858", f: "#22203a", g: "#f4ead8", G: "#c8b898", w: "#8c86a8", c: "#c9c2e0" };
    var bob = frame % 2 === 1 ? 1 : 0;
    var top = facing === "f" ? BOT_FRONT_TOP : BOT_BACK_TOP;
    var map = top.concat(BOT_LEGS[frame]);
    var cv = offscreen(13, 18);
    var c = cv.getContext("2d");
    for (var r = 0; r < map.length; r++) {
      var dy = r < top.length ? bob : 0;
      for (var k = 0; k < 13; k++) {
        var ch = map[r].charAt(k);
        if (ch === "." || !ch) continue;
        c.fillStyle = pal[ch];
        c.fillRect(k, r + dy, 1, 1);
      }
    }
    if (bob) { c.fillStyle = pal.l; c.fillRect(4, 14, 1, 1); c.fillRect(7, 14, 1, 1); }
    botCache[key] = cv;
    return cv;
  }

  function drawShopper(x, y, px, frame, orange, alpha, facing) {
    var spr = botSprite(facing, frame, orange);
    var ox = Math.round(x - 6.5 * px);
    var oy = Math.round(y - 17 * px);
    ctx.save();
    ctx.globalAlpha = alpha * 0.45;
    ctx.fillStyle = "#000";
    ctx.fillRect(ox + 2 * px, Math.round(y), 9 * px, Math.max(1, Math.round(px * 0.7)));
    ctx.globalAlpha = alpha;
    if (orange) {
      ctx.shadowColor = "#f7931a";
      ctx.shadowBlur = 4 + px * 3;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(spr, ox, oy, 13 * px, 18 * px);
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
    var list = [];
    for (var i = 0; i < counts.n; i++) {
      // left lane heads in (back view), right lane comes out with a bag (front view)
      var side = i % 2 === 0 ? -1 : 1;
      var slot = Math.floor(i / 2);
      var span = 0.39;
      var base = 0.53 - slot * 0.095 - (side > 0 ? 0.047 : 0);
      var travel = still ? 0 : (t || 0) * 0.0000045 * (side < 0 ? 1 : -1);
      var d = 0.16 + ((((base - 0.16 - travel * span) % span) + span) % span);
      list.push({ i: i, d: d, side: side });
    }
    list.sort(function (a, b) { return a.d - b.d; }); // far first
    list.forEach(function (s) {
      var depth = s.d * s.d;
      var y = horizon + floorH * depth;
      var x = w * 0.5 + s.side * (roadW * w * 0.95 * depth + 10 + 16 * depth);
      var px = Math.max(1, Math.round(depth * (floorH / 30)));
      var alpha = Math.max(0, Math.min(1, (s.d - 0.16) / 0.04, (0.55 - s.d) / 0.02 + 0.2));
      var frame = still ? (s.i % 2 ? 2 : 0) : Math.floor((t || 0) / 180 + s.i) % 4;
      drawShopper(x, y, px, frame, s.i < counts.orange, alpha, s.side < 0 ? "b" : "f");
    });
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
