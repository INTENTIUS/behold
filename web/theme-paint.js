// behold#1068: the pre-paint theme, a classic script so it runs in <head> before the first frame.
// Loaded by <script src> (index.html), because a webview's content security policy blocks an inline one.
// The kiosk's frame (?bare=1) paints nothing until its theme is applied, so the kiosk's own ground shows through:
// the stylesheet's default --bg is white, and a first load with no stored paint flashed it over a dark pane.
try { if (/[?&]bare=1(&|$)/.test(location.search)) document.documentElement.style.setProperty("--bg", "transparent"); } catch (e) { /* the default paints */ }
try {
  var beholdTheme = localStorage.getItem("behold.theme");
  var beholdPaint = beholdTheme && JSON.parse(localStorage.getItem("behold.theme.paint") || "null");
  if (beholdPaint && beholdPaint.name === beholdTheme && beholdPaint.vars) {
    var beholdRoot = document.documentElement;
    for (var k in beholdPaint.vars) if (k.slice(0, 2) === "--") beholdRoot.style.setProperty(k, beholdPaint.vars[k]);
    if (beholdPaint.scheme) beholdRoot.style.setProperty("color-scheme", beholdPaint.scheme);
  }
} catch (e) { /* private mode or a bad record: the default paints */ }
