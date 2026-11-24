/**
 * The script injected into served HTML pages (watch mode only).
 *
 * - Pings the server once a second via a GET request carrying an
 *   X-HTV-Ping header. The server compares the page file's current
 *   mtime/size against what it served and answers {changed: true/false}.
 * - On change, fetches the new HTML and swaps it in place (replacing
 *   documentElement), preserving the scroll position. Scripts adopted
 *   from a DOMParser document never execute, so they are recreated.
 * - The ping doubles as a heartbeat: if the server sees no ping for
 *   3 seconds it assumes the browser window closed and exits.
 *
 * Constraints: this runs as an inline <script>, so the source must not
 * contain "</script>", and it is embedded in a TypeScript template
 * literal, so it must not contain backticks or "${".
 */
export const CLIENT_SCRIPT = `
(function () {
  "use strict";
  if (window.__htvActive) return;
  window.__htvActive = true;

  var PING_MS = 1000;

  function ping() {
    fetch(location.pathname, {
      method: "GET",
      cache: "no-store",
      headers: { "X-HTV-Ping": "1" }
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.changed) swap();
      })
      .catch(function () { /* server unreachable; keep trying */ });
  }

  var swapping = false;

  function swap() {
    if (swapping) return;
    swapping = true;
    fetch(location.href, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var x = window.scrollX;
        var y = window.scrollY;
        document.replaceChild(doc.documentElement, document.documentElement);
        // Recreate scripts so they execute again (adopted scripts do not).
        // Our own injected script is skipped; its timer keeps running.
        var scripts = document.querySelectorAll("script:not([data-htv])");
        for (var i = 0; i < scripts.length; i++) {
          var s = scripts[i];
          if (!s.parentNode) continue;
          var n = document.createElement("script");
          for (var j = 0; j < s.attributes.length; j++) {
            n.setAttribute(s.attributes[j].name, s.attributes[j].value);
          }
          n.async = false;
          n.textContent = s.textContent;
          s.parentNode.replaceChild(n, s);
        }
        window.scrollTo(x, y);
      })
      .catch(function () { /* e.g. file briefly missing during atomic save */ })
      .then(function () { swapping = false; });
  }

  setInterval(ping, PING_MS);
  ping();
})();
`;

/**
 * Inject the reload script into an HTML document without changing the
 * file on disk. Inserted before the last </body> (or </html>, or at the
 * end for malformed documents). The data-htv attribute marks it so the
 * swap logic can recognize and skip it.
 */
export function injectScript(html: string): string {
  const tag = `<script data-htv="1">${CLIENT_SCRIPT}</script>`;
  const lower = html.toLowerCase();

  const bodyClose = lower.lastIndexOf("</body>");
  if (bodyClose !== -1) {
    return html.slice(0, bodyClose) + tag + html.slice(bodyClose);
  }
  const htmlClose = lower.lastIndexOf("</html>");
  if (htmlClose !== -1) {
    return html.slice(0, htmlClose) + tag + html.slice(htmlClose);
  }
  return html + tag;
}
