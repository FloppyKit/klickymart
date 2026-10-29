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
    var radius = w * (0.11 + btc * 0.28);
    var cx = w * 0.5;
    var cy = horizon + radius * (0.95 - btc * 1.05);
    var glow = 0.15 + btc * 0.55;

    ctx.save();
    var rg = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 2.4);
    var glowCol = light ? "rgba(247,161,40," + glow * 0.5 + ")" : "rgba(247,161,40," + glow + ")";
    rg.addColorStop(0, glowCol);
    rg.addColorStop(1, "rgba(247,161,40,0)");
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 2.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();

    var stripes = Math.floor(8 + btc * 14);
    for (var i = 0; i < stripes; i++) {
      var t = i / stripes;
      var y0 = cy - radius + (2 * radius * i) / stripes;
      var band = radius * 2 / stripes;
      var r = Math.floor(247 - t * 80);
      var g = Math.floor(161 - t * 100);
      var b = Math.floor(40 + t * 20);
      ctx.globalAlpha = 0.55 + btc * 0.45;
      ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
      ctx.fillRect(cx - radius, y0, radius * 2, band + 1);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = light ? "rgba(180,80,40,0.4)" : "rgba(255,200,120,0.35)";
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

  function drawFloor(w, h, horizon, scroll, light) {
    var floorH = h - horizon;
    var fg = ctx.createLinearGradient(0, horizon, 0, h);
    if (light) {
      fg.addColorStop(0, "rgba(20,60,40," + (0.08 + reach * 0.12) + ")");
      fg.addColorStop(1, "rgba(10,30,25," + (0.2 + reach * 0.25) + ")");
    } else {
      fg.addColorStop(0, "rgba(4,20,12," + (0.35 + reach * 0.35) + ")");
      fg.addColorStop(1, "#020508");
    }
    ctx.fillStyle = fg;
    ctx.fillRect(0, horizon, w, floorH);

    if (reach > 0.35) {
      var haze = ctx.createLinearGradient(0, horizon - 20, 0, horizon + 40);
      haze.addColorStop(0, "rgba(61,242,154," + (reach * 0.08) + ")");
      haze.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = haze;
      ctx.fillRect(0, horizon - 20, w, 60);
    }

    var vanishX = w * 0.5;
    var vanishY = horizon;
    var green = css("--km-accent", "#3df29a");
    var lineA = 0.12 + reach * 0.78;
    var glow = reach > 0.5 ? 4 + reach * 6 : 0;

    ctx.lineCap = "round";
    var cols = 10 + Math.floor(reach * 14);
    for (var c = 0; c <= cols; c++) {
      var t = c / cols;
      var x0 = t * w;
      ctx.strokeStyle = green;
      ctx.globalAlpha = lineA * (0.35 + Math.abs(t - 0.5) * 0.9);
      ctx.lineWidth = 1 + reach * 0.8;
      if (glow) ctx.shadowColor = green;
      if (glow) ctx.shadowBlur = glow;
      ctx.beginPath();
      ctx.moveTo(x0, h);
      ctx.lineTo(vanishX, vanishY);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    var rows = 12 + Math.floor(reach * 18);
    for (var r = 0; r <= rows; r++) {
      var z = (r / rows + scroll) % 1;
      var depth = z * z;
      var y = vanishY + floorH * depth;
      var spread = depth * w * 0.72;
      ctx.globalAlpha = lineA * (1 - depth * 0.55);
      ctx.lineWidth = 1 + (1 - depth) * reach;
      ctx.beginPath();
      ctx.moveTo(vanishX - spread, y);
      ctx.lineTo(vanishX + spread, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (reach > 0.65) {
      ctx.fillStyle = light ? "rgba(0,0,0,0.03)" : "rgba(255,255,255,0.02)";
      for (var s = 0; s < 80; s++) {
        var nx = (s * 97) % w;
        var ny = horizon + ((s * 53) % Math.floor(floorH));
        ctx.fillRect(nx, ny, 1, 1);
      }
    }

    ctx.strokeStyle = light ? "rgba(61,242,154,0.35)" : "rgba(61,242,154,0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.lineTo(w, horizon);
    ctx.stroke();
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
