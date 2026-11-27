import { test, expect } from "@playwright/test";
import { spawn, ChildProcess, execFileSync } from "child_process";
import * as http from "http";
import * as fs from "fs";
import * as fspath from "path";
import * as os from "os";

const BIN = fspath.join(__dirname, "..", "dist", "index.js");

// A valid 1x1 transparent PNG.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

interface ServerHandle {
  proc: ChildProcess;
  url: string;
  /** Everything the server has written to stderr so far. */
  readonly stderr: string;
  /** Resolves when the server process exits. */
  exited(timeoutMs?: number): Promise<void>;
  kill(): void;
}

/**
 * Spawn the htv CLI and wait until it logs its serving URL.
 * HTV_NO_OPEN keeps it from trying to open a browser.
 */
function startServer(
  args: string[],
  env: Record<string, string> = {}
): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, HTV_NO_OPEN: "1", HTV_HOST: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      proc.kill();
      reject(err);
    };

    const timeout = setTimeout(
      () => fail(new Error(`server did not start in time; stderr: ${stderr}`)),
      10_000
    );

    proc.stdout!.on("data", (chunk: Buffer) => {
      const m = chunk
        .toString()
        .match(/http:\/\/(?:\[[^\]]+\]|[^:/\s]+):\d+\//);
      if (m && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          proc,
          url: m[0],
          get stderr() {
            return stderr;
          },
          exited: (timeoutMs = 15_000) =>
            new Promise((resolveExit, rejectExit) => {
              const t = setTimeout(
                () => rejectExit(new Error("server did not exit within timeout")),
                timeoutMs
              );
              proc.once("exit", () => {
                clearTimeout(t);
                resolveExit();
              });
            }),
          kill: () => proc.kill(),
        });
      }
    });
    proc.stderr!.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on("exit", (code) => {
      fail(new Error(`server exited early (code ${code}); stderr: ${stderr}`));
    });
  });
}

/**
 * Create a temp directory (with a .git dir, unless opts.git is false)
 * and write the given files into it. Returns the directory path.
 */
function makeRepo(
  files: Record<string, string | Buffer>,
  opts: { git?: boolean } = {}
): string {
  const dir = fs.mkdtempSync(fspath.join(os.tmpdir(), "htv-test-"));
  if (opts.git !== false) fs.mkdirSync(fspath.join(dir, ".git"));
  for (const [rel, content] of Object.entries(files)) {
    const target = fspath.join(dir, rel);
    fs.mkdirSync(fspath.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

/** Raw HTTP GET with an unnormalized path (to test traversal handling). */
function httpGetRaw(
  port: string,
  rawPath: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: rawPath, method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("serves the page with the reload script injected, plus same-dir images", async ({
  page,
}) => {
  const dir = makeRepo({
    "page.html":
      '<!doctype html><html><head><title>123456789012345678901234567890</title></head><body>' +
      "<h1 id=\"t\">Hello htv</h1><img id=\"img\" src=\"pic.png\">" +
      "</body></html>",
    "pic.png": PNG_1PX,
  });
  const file = fspath.join(dir, "page.html");
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(file, fiveMinutesAgo, fiveMinutesAgo);
  const server = await startServer([file]);

  await page.goto(server.url); // "/" redirects to /page.html
  await expect(page.locator("#t")).toHaveText("Hello htv");
  await expect(page).toHaveTitle("1234567890123456789012345 - 5m ✓");

  // The reload script was injected at serve time (not on disk).
  expect(await page.locator("script[data-htv]").count()).toBe(1);
  expect(fs.readFileSync(fspath.join(dir, "page.html"), "utf8")).not.toContain(
    "data-htv"
  );

  // The referenced image resolves.
  expect(
    await page.locator("#img").evaluate((el) => (el as HTMLImageElement).naturalWidth)
  ).toBe(1);

  // A closed websocket is shown with a cross while the client retries.
  server.kill();
  await expect(page).toHaveTitle("1234567890123456789012345 - 5m ✗");
});

test("--host binds to and generates a URL for the requested host", async ({
  page,
}) => {
  const dir = makeRepo({
    "page.html": "<html><body><h1>custom host</h1></body></html>",
  });
  const server = await startServer(
    ["--host=127.0.0.1", fspath.join(dir, "page.html")],
    { HTV_HOST: "localhost" }
  );

  // The command-line flag takes precedence over HTV_HOST.
  expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  await page.goto(server.url);
  await expect(page.locator("h1")).toHaveText("custom host");

  server.kill();
});

test("HTV_HOST binds to and generates a URL for the requested host", async ({
  page,
}) => {
  const dir = makeRepo({
    "page.html": "<html><body><h1>environment host</h1></body></html>",
  });
  const server = await startServer([fspath.join(dir, "page.html")], {
    HTV_HOST: "localhost",
  });

  expect(server.url).toMatch(/^http:\/\/localhost:\d+\/$/);
  await page.goto(server.url);
  await expect(page.locator("h1")).toHaveText("environment host");

  server.kill();
});

test("title age uses days for files at least 24 hours old", async ({ page }) => {
  const dir = makeRepo({
    "page.html": "<html><head><title>Old page</title></head><body></body></html>",
  });
  const file = fspath.join(dir, "page.html");
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(file, twoDaysAgo, twoDaysAgo);
  const server = await startServer([file]);

  await page.goto(server.url);
  await expect(page).toHaveTitle("Old page - 2d ✓");

  server.kill();
});

test("/ redirects to the page's repo-relative path", async ({ page }) => {
  const dir = makeRepo({
    "docs/deep/page.html": "<html><body><h1>deep</h1></body></html>",
  });
  const server = await startServer([fspath.join(dir, "docs/deep/page.html")]);

  const resp = await page.request.get(server.url, { maxRedirects: 0 });
  expect(resp.status()).toBe(302);
  expect(resp.headers()["location"]).toBe("/docs/deep/page.html");

  server.kill();
});

test("serves resources from anywhere under the git root", async ({ page }) => {
  const dir = makeRepo({
    "assets/logo.png": PNG_1PX,
    "docs/deep/page.html":
      '<html><body><img id="img" src="../../assets/logo.png"></body></html>',
  });
  const server = await startServer([fspath.join(dir, "docs/deep/page.html")]);

  await page.goto(server.url);
  expect(
    await page.locator("#img").evaluate((el) => (el as HTMLImageElement).naturalWidth)
  ).toBe(1);

  server.kill();
});

test("blocks requests that escape the server root", async () => {
  const parent = fs.mkdtempSync(fspath.join(os.tmpdir(), "htv-test-"));
  const dir = fspath.join(parent, "repo");
  fs.mkdirSync(fspath.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(fspath.join(dir, "page.html"), "<html><body>ok</body></html>");
  fs.writeFileSync(fspath.join(parent, "secret.txt"), "TOP SECRET");

  const server = await startServer([fspath.join(dir, "page.html")]);
  const port = new URL(server.url).port;

  for (const raw of [
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/..%2fsecret.txt",
    "/%2e%2e%2fsecret.txt",
    "//../secret.txt",
  ]) {
    const r = await httpGetRaw(port, raw);
    expect(r.status, raw).toBe(404);
    expect(r.body, raw).not.toContain("TOP SECRET");
  }

  server.kill();
});

test("falls back to the file's directory (with a warning) when no .git exists", async ({
  page,
}) => {
  const dir = makeRepo(
    {
      "pic.png": PNG_1PX,
      "sub/page.html":
        '<html><body><img id="img" src="../pic.png"></body></html>',
    },
    { git: false }
  );
  const server = await startServer([fspath.join(dir, "sub/page.html")]);

  await page.goto(server.url);
  await expect(page.locator("img")).toHaveCount(1);

  // The page itself works, but the parent-directory image is not served.
  expect(
    await page.locator("#img").evaluate((el) => (el as HTMLImageElement).naturalWidth)
  ).toBe(0);
  expect(server.stderr).toContain("warning");

  server.kill();
});

test("watch mode swaps in changes, preserving scroll and re-running scripts", async ({
  page,
}) => {
  const dir = makeRepo({
    "page.html":
      "<!doctype html><html><head><title>one</title></head><body>" +
      '<h1 id="v">one</h1><div style="height:3000px"></div>' +
      "<script>window.__runs = (window.__runs || 0) + 1;</script>" +
      "</body></html>",
  });
  const file = fspath.join(dir, "page.html");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(file, twoHoursAgo, twoHoursAgo);
  const server = await startServer([file]);

  await page.goto(server.url);
  await expect(page.locator("#v")).toHaveText("one");
  await expect(page).toHaveTitle("one - 2h ✓");
  expect(await page.evaluate(() => window.__runs)).toBe(1);

  await page.evaluate(() => window.scrollTo(0, 1000));
  expect(await page.evaluate(() => window.scrollY)).toBe(1000);

  fs.writeFileSync(
    file,
    "<!doctype html><html><head><title>two</title></head><body>" +
      '<h1 id="v">two</h1><div style="height:3000px"></div>' +
      "<script>window.__runs = (window.__runs || 0) + 1;</script>" +
      "</body></html>"
  );

  // The page should swap in the new content without a navigation.
  await expect
    .poll(() => page.locator("#v").textContent(), { timeout: 15_000 })
    .toBe("two");
  expect(page.url()).toContain("/page.html");

  // Scroll position survived the swap.
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(900);

  // The page's inline script ran again in the same window context, and
  // the status prefix now uses the new document title and modification time.
  expect(await page.evaluate(() => window.__runs)).toBe(2);
  await expect(page).toHaveTitle("two - 0m ✓");

  server.kill();
});

test("watch mode shuts down when the browser window closes", async ({ page }) => {
  const dir = makeRepo({
    "page.html": "<html><body><h1>bye</h1></body></html>",
  });
  const server = await startServer([fspath.join(dir, "page.html")]);

  await page.goto(server.url);
  await expect(page.locator("h1")).toHaveText("bye");

  // The websocket closes with the window; the server should exit (~3s).
  await page.close();
  await server.exited();
});

test("one-shot mode (--no-watch) exits after serving", async ({ page }) => {
  const dir = makeRepo({
    "page.html": "<html><body><h1>one-shot</h1></body></html>",
  });
  const server = await startServer([fspath.join(dir, "page.html"), "-n"]);

  await page.goto(server.url);
  await expect(page.locator("h1")).toHaveText("one-shot");

  // Idle auto-shutdown kicks in shortly after the page is served.
  await server.exited();
});

test("--version prints the version", () => {
  const out = execFileSync(process.execPath, [BIN, "--version"], {
    encoding: "utf8",
  });
  expect(out.trim()).toMatch(/^htv \d+\.\d+\.\d+$/);
});

test("--help prints usage", () => {
  const out = execFileSync(process.execPath, [BIN, "--help"], {
    encoding: "utf8",
  });
  expect(out).toContain("Usage:");
  expect(out).toContain("--no-watch");
  expect(out).toContain("--host <host>");
  expect(out).toContain("HTV_HOST");
});
