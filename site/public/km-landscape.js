(function () {
  var canvas = document.getElementById("km-landscape");
  if (!canvas || !(canvas instanceof HTMLCanvasElement)) return;

  var reach = parseFloat(canvas.getAttribute("data-reach") || "0");
  var btc = parseFloat(canvas.getAttribute("data-btc") || "0");
  var params = new URLSearchParams(window.location.search);
  if (params.has("reach")) {
    var r = parseFloat(params.get("reach") || "");
    if (!Number.isNaN(r) && r >= 0 && r <= 1) reach = r;
  }
  if (params.has("btc")) {
    var b = parseFloat(params.get("btc") || "");
    if (!Number.isNaN(b) && b >= 0 && b <= 1) btc = b;
  }

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = window.innerWidth;
    var h = Math.min(420, Math.max(280, window.innerHeight * 0.45));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h };
  }

  function drawFrame(t) {
    var size = resize();
    var w = size.w;
    var h = size.h;
    ctx.clearRect(0, 0, w, h);

    var skyTop = css("--km-landscape-sky-top") || "#0a0c14";
    var skyBot = css("--km-landscape-sky-bot") || "#1a1428";
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, skyTop);
    g.addColorStop(1, skyBot);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    var horizon = h * (0.58 - btc * 0.12);
    var sunY = horizon - h * (0.08 + btc * 0.22);
    var sunR = 28 + btc * 36;
    var sunAlpha = 0.35 + btc * 0.55;
    var sunG = ctx.createRadialGradient(w * 0.72, sunY, 0, w * 0.72, sunY, sunR * 2.2);
    var sunCore = css("--km-btc") || "#f7a128";
    sunG.addColorStop(0, "rgba(247,161,40," + sunAlpha + ")");
    sunG.addColorStop(0.4, "rgba(247,161,40," + (sunAlpha * 0.35) + ")");
    sunG.addColorStop(1, "rgba(247,161,40,0)");
    ctx.fillStyle = sunG;
    ctx.beginPath();
    ctx.arc(w * 0.72, sunY, sunR * 2.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = sunCore;
    ctx.globalAlpha = 0.85 + btc * 0.15;
    ctx.beginPath();
    ctx.arc(w * 0.72, sunY, sunR * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    var gridColor = css("--km-grid-line") || "rgba(90,67,224,0.15)";
    var lineAlpha = 0.08 + reach * 0.55;
    var lines = 14 + Math.floor(reach * 10);
    var vanishX = w * 0.5;
    var vanishY = horizon;

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;

    for (var i = 0; i <= lines; i++) {
      var tLine = i / lines;
      var x0 = tLine * w;
      ctx.globalAlpha = lineAlpha * (0.4 + tLine * 0.6);
      ctx.beginPath();
      ctx.moveTo(x0, h);
      ctx.lineTo(vanishX, vanishY);
      ctx.stroke();
    }

    var rows = 8 + Math.floor(reach * 6);
    for (var j = 0; j <= rows; j++) {
      var depth = j / rows;
      var y = horizon + (h - horizon) * depth * depth;
      var spread = depth * w * 0.55;
      ctx.globalAlpha = lineAlpha * (1 - depth * 0.35);
      ctx.beginPath();
      ctx.moveTo(vanishX - spread, y);
      ctx.lineTo(vanishX + spread, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (!reduced && t !== undefined) {
      var pulse = 0.02 * Math.sin(t * 0.001);
      ctx.fillStyle = "rgba(11,143,85," + (0.04 + reach * 0.08 + pulse) + ")";
      ctx.fillRect(0, horizon, w, h - horizon);
    } else {
      ctx.fillStyle = "rgba(11,143,85," + (0.05 + reach * 0.1) + ")";
      ctx.fillRect(0, horizon, w, h - horizon);
    }
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

  function stopAnim() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
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
    }, { rootMargin: "120px" });
    io.observe(canvas);
  } else {
    boot();
  }

  window.addEventListener("resize", function () {
    if (reduced || !running) drawFrame(0);
  });
})();
