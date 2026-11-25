/**
 * The script injected into served HTML pages (watch mode only).
 *
 * - Opens a websocket back to the server and declares which file the
 *   page is viewing ("hello"). The server returns its modification time,
 *   watches that file, and sends {changed} when it changes on disk.
 * - Replaces the page title with the first 25 Unicode characters of its
 *   original title, the time since the file changed, and websocket status,
 *   e.g. "Original title - 5m ✓".
 * - On change, fetches the new HTML and swaps it in place (replacing
 *   documentElement), preserving the scroll position. Scripts adopted
 *   from a DOMParser document never execute, so they are recreated.
 * - If the socket drops (e.g. server restarted), reconnects and retries,
 *   re-sending the "hello" after each reconnect.
 * - When every page has disconnected for 3 seconds the server exits
 *   (the browser window was closed).
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

  var swapping = false;
  var socketOpen = false;
  var changedAt = Date.now();
  var originalTitle = document.title;

  function ageText() {
    var minutes = Math.max(0, Math.floor((Date.now() - changedAt) / 60000));
    if (minutes < 60) return minutes + "m";
    if (minutes < 1440) return Math.floor(minutes / 60) + "h";
    return Math.floor(minutes / 1440) + "d";
  }

  function updateTitle() {
    var title = Array.from(originalTitle).slice(0, 25).join("");
    document.title = title + " - " + ageText() + " " +
      (socketOpen ? "✓" : "✗");
  }

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
        originalTitle = doc.title;
        document.replaceChild(doc.documentElement, document.documentElement);
        // Recreate scripts so they execute again (adopted scripts do not).
        // Our own injected script is skipped; its socket stays connected.
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
        updateTitle();
      })
      .catch(function () { /* e.g. file briefly missing during atomic save */ })
      .then(function () { swapping = false; });
  }

  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var ws = new WebSocket(proto + "//" + location.host);
    ws.onopen = function () {
      socketOpen = true;
      updateTitle();
      ws.send(JSON.stringify({ type: "hello", path: location.pathname }));
    };
    ws.onmessage = function (e) {
      try {
        var d = JSON.parse(e.data);
        if (d && typeof d.mtimeMs === "number") {
          changedAt = d.mtimeMs;
          updateTitle();
        }
        if (d && d.type === "changed") swap();
      } catch (err) { /* ignore */ }
    };
    ws.onclose = function () {
      socketOpen = false;
      updateTitle();
      // Server gone or connection dropped; retry in case it restarts.
      setTimeout(connect, 1000);
    };
  }

  updateTitle();
  setInterval(updateTitle, 1000);
  connect();
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
