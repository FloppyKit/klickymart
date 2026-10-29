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
    b.addEventListener("click", function () {
      var t = el.querySelector("code");
      if (t && navigator.clipboard) navigator.clipboard.writeText(t.textContent || "");
    });
    el.insertBefore(b, el.firstChild);
  });
})();
