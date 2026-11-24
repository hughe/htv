#!/usr/bin/env node
import * as http from "http";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";
import { findServerRoot } from "./root";
import { injectScript } from "./inject";
import { setupWatch } from "./watch";
import { MIME_TYPES, escapeHtml, resolveUrlPath } from "./util";

const USAGE = `htv - html viewer with live reload

Usage:
  htv <html-file> [port]

Options:
  <html-file>      Path to an HTML (.html/.htm) file to view
  [port]           Optional port to listen on (default: 0 = random free port)
  -n, --no-watch   One-shot mode: no live reload; shut down once the page
                   has been served
  -v, --version    Show version
  -h, --help       Show this help

By default htv runs in watch mode: the page reloads in place (keeping
the scroll position) when the file changes, and the server shuts down
when the browser window closes.

The server root is the enclosing git repository (the nearest ancestor
directory containing .git/), so pages may reference any file in the
repo. If no .git/ is found, only the file's own directory is served
and a warning is printed.

Starts a local web server serving the file, then opens the URL in
your default browser.
`;

function getVersion(): string {
  // dist/index.js lives one level below package.json
  const pkgPath = path.join(__dirname, "..", "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version;
  } catch {
    return "unknown";
  }
}

function fail(message: string): never {
  console.error(`error: ${message}\n`);
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let file: string | undefined;
  let port = 0;
  let watch = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "-v" || arg === "--version") {
      console.log(`htv ${getVersion()}`);
      process.exit(0);
    }
    if (arg === "-n" || arg === "--no-watch") {
      watch = false;
      continue;
    }
    if (arg === "-w" || arg === "--watch") {
      // Watch is the default; keep the flag for compatibility.
      watch = true;
      continue;
    }
    if (file === undefined) {
      file = arg;
    } else {
      const parsed = Number(arg);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        fail(`invalid port: ${arg}`);
      }
      port = parsed;
    }
  }

  if (file === undefined) {
    fail("no html file given");
  }
  return { file, port, watch };
}

function isHtmlFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".html" || ext === ".htm";
}

function openUrl(url: string): void {
  if (process.env.HTV_NO_OPEN) {
    console.log(`HTV_NO_OPEN set; open manually: ${url}`);
    return;
  }
  // `open` (macOS) with fallbacks for other platforms.
  const candidates = process.platform === "darwin" ? ["open"] : ["xdg-open", "open"];
  for (const cmd of candidates) {
    try {
      const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
      child.on("error", () => {
        /* try next candidate on next tick */
      });
      child.unref();
      return;
    } catch {
      /* try next */
    }
  }
  console.log(`Could not open browser automatically; please visit: ${url}`);
}

function main(): void {
  const { file, port, watch } = parseArgs(process.argv.slice(2));

  const absFile = path.resolve(file);
  if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
    fail(`file not found: ${file}`);
  }

  const { root, fallback } = findServerRoot(absFile);
  if (fallback) {
    console.warn(
      `warning: no .git directory found above ${absFile}; ` +
        `serving only from its own directory`
    );
  }

  // URL path of the page, relative to the server root.
  const pageUrlPath =
    "/" + path.relative(root, absFile).split(path.sep).join("/");

  // ── state ──────────────────────────────────────────────────────────────
  // One-shot (no-watch) auto-shutdown state, mirroring mdv.
  const IDLE_SHUTDOWN_MS = 3000;
  const sockets = new Set<http.IncomingMessage["socket"]>();
  let pageServed = false;
  let shutdownTimer: NodeJS.Timeout | null = null;
  let server: http.Server;

  function shutdown(reason: string): void {
    console.log(`htv: ${reason}`);
    server.close(() => process.exit(0));
    // In case close callbacks never fire (lingering handles):
    setTimeout(() => process.exit(0), 1000).unref();
  }

  function maybeScheduleShutdown(): void {
    if (watch || !pageServed || sockets.size > 0 || shutdownTimer !== null) return;
    shutdownTimer = setTimeout(() => {
      shutdownTimer = null;
      if (sockets.size === 0) {
        shutdown("page served; shutting down");
      } else {
        maybeScheduleShutdown();
      }
    }, IDLE_SHUTDOWN_MS);
  }

  server = http.createServer(async (req, res) => {
    const urlPath = (req.url || "/").split("?")[0];

    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "text/plain", Connection: "close" });
        res.end("Method Not Allowed");
        return;
      }

      // The server root itself redirects to the page.
      if (urlPath === "/") {
        res.writeHead(302, {
          Location: encodeURI(pageUrlPath),
          "Cache-Control": "no-store",
          Connection: "close",
        });
        res.end();
        return;
      }

      const filePath = resolveUrlPath(urlPath, root);
      if (filePath === null) {
        res.writeHead(404, {
          "Content-Type": "text/html; charset=utf-8",
          Connection: "close",
        });
        res.end(
          `<h1>404 Not Found</h1><p>${escapeHtml(urlPath)} is outside the server root</p>`
        );
        return;
      }

      let stat: fs.Stats;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        stat = null as unknown as fs.Stats;
      }
      if (!stat || !stat.isFile()) {
        res.writeHead(404, {
          "Content-Type": "text/html; charset=utf-8",
          Connection: "close",
        });
        res.end(
          `<h1>404 Not Found</h1><p>${escapeHtml(urlPath)} was not found under <code>${escapeHtml(root)}</code></p>`
        );
        return;
      }

      if (isHtmlFile(filePath)) {
        const content = await fsp.readFile(filePath, "utf8");
        const body = watch ? injectScript(content) : content;
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "close",
        });
        res.end(req.method === "HEAD" ? undefined : body);
        pageServed = true;
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stat.size,
        Connection: "close",
      });
      if (req.method === "HEAD") {
        res.end();
      } else {
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err) {
      console.error(err);
      res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" });
      res.end("Internal Server Error");
    }
  });

  // Track open connections; when the page is served and they all drain,
  // schedule the automatic shutdown (no-watch mode only).
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      maybeScheduleShutdown();
    });
  });

  if (watch) {
    // WebSocket-based live reload: the injected script connects back,
    // the server watches each viewed file, and the process exits once
    // every page has been gone for 3 seconds (browser window closed).
    setupWatch(server, root, (msg) => console.log(`htv: ${msg}`));
  }

  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
    const url = `http://localhost:${actualPort}${pageUrlPath}`;
    console.log(
      `htv: serving ${path.relative(root, absFile)} at ${url} ` +
        `(root: ${root}; ` +
        (watch
          ? "watch mode: reloads on change, shuts down when the browser window closes"
          : "shuts down automatically once the page is served") +
        "; Ctrl+C to stop)"
    );
    openUrl(url);
  });

  process.on("SIGINT", () => {
    console.log("\nhtv: shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

main();
