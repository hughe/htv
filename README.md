# htv — HTML viewer with live reload

`htv` serves a local HTML file on a throwaway web server and opens it in
your browser. When the file changes on disk, the page updates **in place**
(scroll position preserved), and when you close the browser tab the server
exits by itself. No leftover processes, no port juggling.

    htv index.html
    htv docs/manual.html 8080

Inspired by [mdv](https://github.com/hughe/mdv) (the markdown viewer), but for raw HTML.

## How it works

- `htv <file.html> [port]` starts an HTTP server on `127.0.0.1`
  (random free port by default) and opens the URL in your default browser.
- The **server root** is the enclosing git repository — the nearest
  ancestor directory containing `.git/` — so pages can reference any file
  in the repo (images, CSS, other pages). If no `.git/` is found, `htv`
  falls back to the file's own directory and prints a warning.
- URLs mirror the repo: a page at `docs/manual.html` is served at
  `/docs/manual.html`; `/` redirects to the file you named.
- Served HTML pages get a small script injected (never written to disk)
  that opens a websocket back to the server. The server watches each
  viewed file and pushes a notification on change; the page then fetches
  the new HTML and swaps the document in place, preserving scroll
  position and re-running the page's scripts.
- The tab title is prefixed with websocket status and the age of the
  viewed file, for example `✓ 5m - Original title`. Ages use whole
  minutes (`Nm`), hours (`Nh`), or days (`Nd`). A disconnected websocket
  is shown with `✗` until it reconnects.
- When every websocket has been gone for 3 seconds — i.e. the browser
  window was closed — the server exits.

## Usage

```
htv - html viewer with live reload

Usage:
  htv <html-file> [port]

Options:
  <html-file>      Path to an HTML (.html/.htm) file to view
  [port]           Optional port to listen on (default: 0 = random free port)
  -n, --no-watch   One-shot mode: no live reload; shut down once the page
                   has been served
  -v, --version    Show version
  -h, --help       Show this help
```

## Install

    ./install.sh

Requires Node.js 18+. Symlinks `htv` into `~/.local/bin` (override with
`HTV_BIN_DIR=...`).

## Notes

- The server binds to `127.0.0.1` only, and rejects any path that escapes
  the server root.
- Files outside the git root (or the fallback directory) are never served.
- Set `HTV_NO_OPEN=1` to skip opening a browser (used by the tests).
- Live reload uses a websocket per open page (like mdv); each page
  registers the file it is viewing, so navigating to another page in the
  repo keeps live-reload and auto-exit behavior working.

## Development

    npm install
    npm run build     # tsc -> dist/

### Running the test suite

    npx playwright install   # one-time: download the Chromium test browser
    npm test                 # build + run the Playwright tests

The suite covers injection at serve time, git-root asset serving,
traversal blocking, the no-`.git` fallback warning, the in-place swap
(scroll preservation, script re-execution, and title status),
window-close shutdown, and one-shot mode. It runs headless Chromium
against a throwaway server per test; no browser window opens.

### Manual smoke test

Serve the bundled demo page and try the behaviors by hand:

    node dist/index.js test.html

- the **Script runs** counter increments once per swap — edit
  `test.html` and save, the page updates in place
- scroll down before editing; the scroll position survives the swap
- the page references `assets/diagram.svg`, exercising git-root serving
- close the tab; the server exits after ~3 seconds
