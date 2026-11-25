import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { resolveUrlPath } from "./util";

const DEBOUNCE_MS = 200; // collapse editor save bursts into one reload
const CLOSE_GRACE_MS = 3000; // allow reconnects before treating as window closed

/**
 * Set up watch mode (mdv-style, generalized to multiple pages):
 *  - a websocket server (the script injected into served pages connects
 *    back and declares which file it is viewing)
 *  - refcounted file watching per viewed file; changes push a "changed"
 *    message to the pages viewing that file
 *  - when every page has disconnected and none come back within a grace
 *    period, the process exits
 *
 * Unlike mdv, any HTML page under the server root can be viewed, so each
 * connection registers the file behind its URL and only that file is
 * watched while at least one page views it.
 */
export function setupWatch(
  server: http.Server,
  root: string,
  log: (msg: string) => void
): void {
  const wss = new WebSocketServer({ server });

  interface Client {
    ws: WebSocket;
    /** Absolute path of the file this page is viewing (after "hello"). */
    file: string | null;
  }
  const clients = new Set<Client>();
  let everConnected = false;
  let exitTimer: NodeJS.Timeout | null = null;

  function shutdown(reason: string): void {
    log(reason);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }

  function scheduleExitCheck(): void {
    if (clients.size > 0 || !everConnected || exitTimer !== null) return;
    // All pages disconnected. A browser reload briefly closes the socket
    // before opening a new one, so wait a moment before declaring the
    // window closed. A reconnect cancels the timer.
    exitTimer = setTimeout(() => {
      exitTimer = null;
      if (clients.size === 0) {
        shutdown("browser window closed; shutting down");
      }
    }, CLOSE_GRACE_MS);
  }

  // ── file watching, refcounted per viewed file ──────────────────────────
  const watchers = new Map<string, { count: number; close: () => void }>();
  const debounce = new Map<string, NodeJS.Timeout>();

  function fileMtimeMs(file: string): number | null {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  function trigger(file: string): void {
    if (debounce.has(file)) return;
    debounce.set(
      file,
      setTimeout(() => {
        debounce.delete(file);
        const mtimeMs = fileMtimeMs(file);
        if (mtimeMs === null) return; // mid atomic-save rename; ignore
        const data = JSON.stringify({ type: "changed", mtimeMs });
        let viewers = 0;
        for (const c of clients) {
          if (c.file === file && c.ws.readyState === WebSocket.OPEN) {
            c.ws.send(data);
            viewers++;
          }
        }
        if (viewers > 0) {
          log(`file changed; reloading ${path.relative(root, file)}`);
        }
      }, DEBOUNCE_MS)
    );
  }

  function acquireWatch(file: string): void {
    const existing = watchers.get(file);
    if (existing) {
      existing.count++;
      return;
    }
    const closers: Array<() => void> = [];
    // Watch the file itself...
    try {
      const w = fs.watch(file);
      w.on("change", () => trigger(file));
      w.on("error", () => {
        /* file may be replaced atomically; the directory watch covers it */
      });
      closers.push(() => w.close());
    } catch {
      /* file may not exist yet; the directory watch covers it */
    }
    // ...and its directory: many editors replace files atomically
    // (write temp + rename), which invalidates a plain file watch.
    try {
      const dw = fs.watch(path.dirname(file), (_event, filename) => {
        if (filename === path.basename(file)) trigger(file);
      });
      dw.on("error", () => {
        /* ignore */
      });
      closers.push(() => dw.close());
    } catch {
      /* ignore */
    }
    watchers.set(file, { count: 1, close: () => closers.forEach((c) => c()) });
  }

  function releaseWatch(file: string): void {
    const entry = watchers.get(file);
    if (!entry) return;
    entry.count--;
    if (entry.count === 0) {
      entry.close();
      watchers.delete(file);
    }
  }

  // ── connections ────────────────────────────────────────────────────────
  wss.on("connection", (ws) => {
    everConnected = true;
    if (exitTimer !== null) {
      clearTimeout(exitTimer);
      exitTimer = null;
    }
    const client: Client = { ws, file: null };
    clients.add(client);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type !== "hello" || typeof msg.path !== "string") return;
        const file = resolveUrlPath(msg.path.split("?")[0], root);
        if (!file) return;
        if (client.file !== file) {
          if (client.file !== null) releaseWatch(client.file);
          client.file = file;
          acquireWatch(file);
        }
        const mtimeMs = fileMtimeMs(file);
        if (mtimeMs !== null && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ready", mtimeMs }));
        }
      } catch {
        /* ignore malformed messages */
      }
    });

    ws.on("close", () => {
      clients.delete(client);
      if (client.file !== null) releaseWatch(client.file);
      scheduleExitCheck();
    });
    ws.on("error", () => {
      /* ignore; close will follow */
    });
  });
}
