(function () {
  var canvas = document.getElementById("km-landscape");
  if (!canvas || !(canvas instanceof HTMLCanvasElement)) return;

  var reach = clamp01(parseFloat(canvas.getAttribute("data-reach") || "0"));
  var btc = clamp01(parseFloat(canvas.getAttribute("data-btc") || "0"));
  var params = new URLSearchParams(window.location.search);
  if (params.has("reach")) {
    var r = parseFloat(params.get("reach") || "");
    if (!Number.isNaN(r)) reach = clamp01(r);
  }
  if (params.has("btc")) {
    var b = parseFloat(params.get("btc") || "");
    if (!Number.isNaN(b)) btc = clamp01(b);
  }

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var ctx = canvas.getContext("2d");
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
    return window.matchMedia("(prefers-color-scheme: light)").matches;
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = window.innerWidth;
    var h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h };
  }

  function drawSky(w, h, light) {
    var horizon = h * (0.44 + reach * 0.06);
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

    ctx.save();
    ctx.strokeStyle = "rgba(255,220,140,0.45)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawMountains(w, horizon, light) {
    function hPx(frac) {
      return window.innerHeight * frac * (0.7 + reach * 0.3);
    }
    var peaks = [
      [0, horizon, w * 0.12, horizon - hPx(0.08), w * 0.22, horizon],
      [w * 0.18, horizon, w * 0.34, horizon - hPx(0.14), w * 0.5, horizon],
      [w * 0.42, horizon, w * 0.58, horizon - hPx(0.11), w * 0.72, horizon],
      [w * 0.65, horizon, w * 0.82, horizon - hPx(0.16), w, horizon],
    ];

    var fillA = reach * (light ? 0.25 : 0.45);
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
    var lineA = 0.35 + reach * 0.65;
    var blur = 6 + reach * 12;

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

    drawHorizonGlow(w, horizon, green, light);

    if (reach > 0.65) {
      ctx.fillStyle = light ? "rgba(0,0,0,0.03)" : "rgba(255,255,255,0.025)";
      for (var s = 0; s < 80; s++) {
        var nx = (s * 97) % w;
        var ny = horizon + ((s * 53) % Math.floor(floorH));
        ctx.fillRect(nx, ny, 1, 1);
      }
    }
  }

  function drawFrame(t) {
    var size = resize();
    var w = size.w;
    var h = size.h;
    var light = isLightTheme();
    var scroll = reduced ? 0 : ((t || 0) * 0.00012) % 1;

    ctx.clearRect(0, 0, w, h);
    var horizon = drawSky(w, h, light);
    drawSun(w, horizon, light);
    drawMountains(w, horizon, light);
    drawFloor(w, h, horizon, scroll, light);
  }

  var running = false;
  var raf = 0;

  function startAnim() {
    if (reduced || running) return;
    running = true;
    function loop(ts) {
      drawFrame(ts);
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);
  }

  function boot() {
    drawFrame(0);
    if (!reduced) startAnim();
  }

  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          if ("requestIdleCallback" in window) {
            requestIdleCallback(function () { boot(); }, { timeout: 800 });
          } else {
            setTimeout(boot, 50);
          }
          io.disconnect();
        }
      });
    }, { rootMargin: "0px" });
    io.observe(canvas);
  } else {
    boot();
  }

  window.addEventListener("resize", function () {
    drawFrame(reduced ? 0 : performance.now());
  });

  document.getElementById("km-theme-toggle")?.addEventListener("click", function () {
    setTimeout(function () { drawFrame(reduced ? 0 : performance.now()); }, 50);
  });
})();
