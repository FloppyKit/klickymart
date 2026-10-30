(function () {
  var KEY = "km-theme";
  var root = document.documentElement;
  function apply(t) {
    if (t === "light" || t === "dark") root.setAttribute("data-theme", t);
    else root.removeAttribute("data-theme");
  }
  try {
    apply(localStorage.getItem(KEY));
  } catch (e) {}
  var btn = document.getElementById("km-theme-toggle");
  if (btn) {
    btn.addEventListener("click", function () {
      var cur = root.getAttribute("data-theme");
      var next = cur === "dark" ? "light" : cur === "light" ? "dark" : matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark";
      try { localStorage.setItem(KEY, next); } catch (e) {}
      apply(next);
    });
  }
  document.querySelectorAll(".km-codeblock").forEach(function (el) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = "Copy";
    b.className = "km-copy";
    b.setAttribute("aria-label", "Copy to clipboard");
    b.addEventListener("click", function () {
      var t = el.querySelector("code");
      if (t && navigator.clipboard) {
        navigator.clipboard.writeText(t.textContent || "").then(function () {
          b.textContent = "Copied";
          b.setAttribute("data-copied", "1");
          setTimeout(function () { b.textContent = "Copy"; b.removeAttribute("data-copied"); }, 1400);
        }, function () {});
      }
    });
    el.insertBefore(b, el.firstChild);
  });
})();

/* "Can my agent shop here?" inline check (progressive enhancement; the form works without JS). */
(function () {
  var form = document.querySelector('[data-testid="check-form"]');
  var out = document.getElementById("check-result");
  if (!form || !out) return;
  form.addEventListener("submit", function (e) {
    var d = form.querySelector("input[name=domain]").value;
    if (!d) return;
    e.preventDefault();
    out.textContent = "Checking…";
    fetch("/check?format=html&domain=" + encodeURIComponent(d), { headers: { Accept: "text/html" } })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var res = doc.querySelector('[data-testid="check-result"]');
        out.innerHTML = res ? res.innerHTML : "Check failed.";
      })
      .catch(function () { out.textContent = "Check failed."; });
  });
})();
