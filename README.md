# htv — HTML viewer with live reload

`htv` serves a local HTML file on a throwaway web server and opens it in
your browser. When the file changes on disk, the page updates **in place**
(scroll position preserved), and when you close the browser tab the server
exits by itself. No leftover processes, no port juggling.

    htv index.html
    htv docs/manual.html 8080

Inspired by [`mdv`](../mdv) (the markdown viewer), but for raw HTML.

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
  that pings the server every second. The server compares the file's
  mtime/size against what it served; on change the client fetches the new
  HTML and swaps the document in place, preserving scroll position and
  re-running the page's scripts.
- If the server sees no ping for 3 seconds — i.e. the browser window was
  closed — it exits.

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
- Live reload watches the file you're viewing; each open page monitors
  its own file, so navigating to another page in the repo keeps
  live-reload and auto-exit behavior working.

## Development

    npm install
    npm run build     # tsc -> dist/
    npm test          # build + playwright tests (needs `npx playwright install`)
