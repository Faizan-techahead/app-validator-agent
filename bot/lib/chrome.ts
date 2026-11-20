import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

/** Inner MacOS binary names for common Chromium-family .app bundles. */
const MAC_APP_BINARIES = [
  "Google Chrome",
  "Chromium",
  "Google Chrome Canary",
  "Google Chrome for Testing",
  "Microsoft Edge",
] as const;

/**
 * If `path` is a macOS .app bundle (ends with `.app`), resolve to the
 * executable under Contents/MacOS/. Otherwise return `path` when it exists.
 */
export function resolveChromeExecutable(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return undefined;

  const normalized = trimmed.replace(/\/+$/, "");
  if (/\.app$/i.test(normalized)) {
    const macOsDir = join(normalized, "Contents", "MacOS");
    // Prefer binary matching the .app name, then known Chromium-family names.
    const appName = basename(normalized, ".app");
    const ordered = [appName, ...MAC_APP_BINARIES.filter((n) => n !== appName)];
    for (const name of ordered) {
      const candidate = join(macOsDir, name);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  if (existsSync(normalized)) return normalized;
  return undefined;
}

/** True when APP_VALIDATOR_HEADED is 1/true/yes — show a real Chrome window. */
export function isChromeHeaded(): boolean {
  const v = (process.env.APP_VALIDATOR_HEADED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "headed";
}

/** Shared Chrome flags; omits --headless=new when headed. */
export function chromeProcessArgs(extra: string[]): string[] {
  const headed = isChromeHeaded();
  const base = [
    ...(headed ? [] : ["--headless=new"]),
    ...(headed ? [] : ["--disable-gpu"]),
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--no-first-run",
    "--window-size=1280,900",
    ...extra,
  ];
  return base;
}

/** Resolve a Chrome/Chromium binary, including common macOS app paths. */
export function findChromeBinary(): string | undefined {
  if (process.env.APP_VALIDATOR_FORCE_CURL === "1") return undefined;

  const fromEnv = process.env.CHROME_PATH?.trim();
  if (fromEnv) {
    const resolved = resolveChromeExecutable(fromEnv);
    if (resolved) return resolved;
  }

  const whichCandidates = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
  ];
  for (const bin of whichCandidates) {
    const which = spawnSync("which", [bin], { encoding: "utf8" });
    if (which.status === 0 && which.stdout.trim()) {
      const resolved = resolveChromeExecutable(which.stdout.trim());
      if (resolved) return resolved;
    }
  }

  const home = process.env.HOME ?? "";
  const macBundles = [
    "/Applications/Google Chrome.app",
    "/Applications/Chromium.app",
    "/Applications/Google Chrome Canary.app",
    home ? join(home, "Applications", "Google Chrome.app") : "",
    home ? join(home, "Applications", "Chromium.app") : "",
    home ? join(home, "Applications", "Google Chrome Canary.app") : "",
  ];
  for (const bundle of macBundles) {
    if (!bundle) continue;
    const resolved = resolveChromeExecutable(bundle);
    if (resolved) return resolved;
  }

  // Also accept pre-resolved inner binaries (legacy hard-coded paths).
  const macBinaries = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    home ? join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome") : "",
  ];
  for (const p of macBinaries) {
    if (p && existsSync(p)) return p;
  }

  return undefined;
}

export type CdpClient = {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
  proc: ChildProcess;
  port: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPageDebuggerUrl(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      // Prefer a page target — browser-level /json/version WS does not expose Page.*
      const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (listRes.ok) {
        const list = (await listRes.json()) as Array<{
          type?: string;
          webSocketDebuggerUrl?: string;
        }>;
        const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
        lastErr = `pages=${list.length}`;
      } else {
        lastErr = `list_status=${listRes.status}`;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await sleep(200);
  }
  throw new Error(`Chrome page DevTools not ready on :${port} (${lastErr})`);
}

/** Launch Chrome with a CDP port for SPA automation (headless by default; headed via APP_VALIDATOR_HEADED=1). */
export async function launchChromeCdp(chromePath: string): Promise<CdpClient> {
  const port = 9200 + Math.floor(Math.random() * 600);
  const headed = isChromeHeaded();
  const proc = spawn(
    chromePath,
    chromeProcessArgs([
      `--remote-debugging-port=${port}`,
      ...(headed ? ["--new-window"] : []),
      "about:blank",
    ]),
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  try {
    const wsUrl = await waitForPageDebuggerUrl(port, 12_000);
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP WebSocket connect timeout")), 10_000);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("CDP WebSocket error"));
      });
    });

    let nextId = 1;
    const pending = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (msg.id == null) return;
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
        else p.resolve(msg.result);
      } catch {
        /* ignore */
      }
    });

    const send = (method: string, params?: Record<string, unknown>) =>
      new Promise<unknown>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP timeout: ${method}`));
          }
        }, 25_000);
      });

    const close = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };

    proc.on("exit", () => {
      for (const [, p] of pending) p.reject(new Error("Chrome exited"));
      pending.clear();
    });

    return { send, close, proc, port };
  } catch (e) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export async function cdpEvaluate(
  client: CdpClient,
  expression: string,
): Promise<{ value?: unknown; exception?: string }> {
  const result = (await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as {
    result?: { value?: unknown; description?: string };
    exceptionDetails?: { text?: string };
  };
  if (result.exceptionDetails) {
    return { exception: result.exceptionDetails.text ?? "evaluate exception" };
  }
  return { value: result.result?.value };
}
