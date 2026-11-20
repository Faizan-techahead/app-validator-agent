import { spawnSync } from "node:child_process";
import {
  attemptFormLogin,
  fetchWithCookie,
  type LoginAttemptResult,
  type ResolvedAuth,
} from "./auth";
import { chromeProcessArgs, findChromeBinary, isChromeHeaded } from "./chrome";
import { redactLogLines } from "./redact";
import { captureAndroidScreenshot, captureChromeScreenshot, captureIosScreenshot } from "./screenshots";
import { attemptSpaLogin } from "./spa-login";
import type { CaseResult, FailureScreenshot, MobilePlatform, NormalizedCase } from "./types";

function findChrome(): string | undefined {
  return findChromeBinary();
}

async function attemptLoginBestEffort(
  baseUrl: string,
  auth: ResolvedAuth,
  mode: "valid" | "invalid",
): Promise<LoginAttemptResult & { via?: string }> {
  if (findChromeBinary()) {
    const spa = await attemptSpaLogin(baseUrl, auth, mode);
    if (spa.via === "chrome-spa") {
      const shouldTryCurl =
        !spa.ok &&
        /no password input|could not fill|non-standard auth|failed to run|DevTools not ready|CDP WebSocket|SPA Chrome login failed/i.test(
          spa.detail,
        );
      if (shouldTryCurl) {
        const form = attemptFormLogin(baseUrl, auth, mode);
        return {
          ...form,
          via: "curl-form",
          log: redactLogLines([...spa.log, ...form.log, "fallback=curl-form"]),
        };
      }
      return spa;
    }
  }
  const form = attemptFormLogin(baseUrl, auth, mode);
  return { ...form, via: "curl-form" };
}

type PageFetch = {
  ok: boolean;
  excerpt: string;
  html: string;
  httpCode?: number;
  error?: string;
  via: "chrome" | "curl";
  log: string[];
};

function fetchViaCurl(url: string): Omit<PageFetch, "via"> & { via?: "curl" } {
  // Do not use -f: we need HTTP status for 404 exploratory cases.
  const result = spawnSync(
    "curl",
    ["-sSL", "--max-time", "15", "-A", "app-validator-chrome-fallback/1.0", "-w", "\nHTTP_CODE:%{http_code}", url],
    { encoding: "utf8", maxBuffer: 5_000_000 },
  );
  const log = [
    `curl ${url}`,
    `exit=${result.status}`,
    result.stderr ? `stderr=${result.stderr.slice(0, 300)}` : "",
  ].filter(Boolean);
  if (result.error) {
    return {
      ok: false,
      excerpt: "",
      html: "",
      error: result.error.message,
      log: [...log, result.error.message],
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      excerpt: (result.stderr || "").slice(0, 500),
      html: "",
      error: `curl exited ${result.status}`,
      log,
    };
  }
  const raw = result.stdout ?? "";
  const codeMatch = /HTTP_CODE:(\d+)\s*$/.exec(raw);
  const html = codeMatch ? raw.slice(0, codeMatch.index) : raw;
  const httpCode = codeMatch ? Number(codeMatch[1]) : undefined;
  return {
    ok: html.length > 0 || (httpCode !== undefined && httpCode >= 100),
    excerpt: html.replace(/\s+/g, " ").slice(0, 1200),
    html: html.slice(0, 200_000),
    httpCode,
    log: [...log, `http_code=${httpCode ?? "unknown"}`, `body_bytes≈${html.length}`],
  };
}

function fetchPage(chrome: string | undefined, url: string): PageFetch {
  if (!chrome) {
    const fallback = fetchViaCurl(url);
    return {
      ok: fallback.ok,
      excerpt: fallback.excerpt,
      html: fallback.html,
      httpCode: fallback.httpCode,
      error: fallback.ok
        ? "Chrome binary missing; used curl HTML fallback."
        : fallback.error ?? "curl fetch failed",
      via: "curl",
      log: ["chrome=missing", ...fallback.log, "fallback=curl"],
    };
  }
  const headed = isChromeHeaded();
  const result = spawnSync(
    chrome,
    chromeProcessArgs([
      ...(headed ? [] : ["--virtual-time-budget=3000", "--timeout=10000"]),
      "--dump-dom",
      url,
    ]),
    { encoding: "utf8", maxBuffer: 5_000_000, timeout: headed ? 45_000 : 20_000 },
  );
  const chromeLog = [
    `chrome --dump-dom ${url}`,
    `headed=${headed}`,
    `exit=${result.status}`,
    result.error ? `error=${result.error.message}` : "",
    result.stderr ? `stderr=${result.stderr.slice(0, 300)}` : "",
  ].filter(Boolean);
  if (!result.error && result.status === 0 && (result.stdout ?? "").length > 0) {
    const html = result.stdout ?? "";
    return {
      ok: true,
      excerpt: html.replace(/\s+/g, " ").slice(0, 1200),
      html: html.slice(0, 200_000),
      via: "chrome",
      log: [...chromeLog, `dom_bytes≈${html.length}`],
    };
  }
  const chromeError =
    result.error?.message ?? ((result.stderr || "").trim() || `Chrome exited ${result.status}`);
  const fallback = fetchViaCurl(url);
  if (fallback.ok) {
    return {
      ok: true,
      excerpt: fallback.excerpt,
      html: fallback.html,
      httpCode: fallback.httpCode,
      error: `Chrome unavailable (${chromeError}); used curl HTML fallback.`,
      via: "curl",
      log: [...chromeLog, ...fallback.log, "fallback=curl"],
    };
  }
  return {
    ok: false,
    excerpt: "",
    html: "",
    httpCode: fallback.httpCode,
    error: `Chrome: ${chromeError}; curl: ${fallback.error ?? "failed"}`,
    via: "curl",
    log: [...chromeLog, ...fallback.log],
  };
}

function looksLikeNavStep(step: string): boolean {
  return /^(open|goto|go to|navigate|visit|load)\b/i.test(step.trim());
}

function urlFromSteps(steps: string[], fallback: string): string {
  for (const step of steps) {
    if (!looksLikeNavStep(step)) continue;
    const m = /\bhttps?:\/\/\S+/i.exec(step);
    if (m) return m[0]!.replace(/[.,);]+$/, "");
  }
  return fallback;
}

function evalAssert(
  kind: string,
  page: PageFetch,
  homePage?: PageFetch,
): { pass: boolean; detail: string } {
  const html = page.html || page.excerpt;
  const lower = html.toLowerCase();
  switch (kind) {
    case "ASSERT:TITLE": {
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      const title = (m?.[1] ?? "").replace(/\s+/g, " ").trim();
      return title.length > 0
        ? { pass: true, detail: `title="${title.slice(0, 80)}"` }
        : { pass: false, detail: "No non-empty <title> found." };
    }
    case "ASSERT:HEADING_OR_MAIN": {
      const ok =
        /<h[1-6]\b/i.test(html) ||
        /<main\b/i.test(html) ||
        /role=["']main["']/i.test(html) ||
        /<(article|section|header)\b/i.test(html) ||
        (html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").trim().length > 80);
      return ok
        ? { pass: true, detail: "Found heading/main landmark or substantial body text." }
        : { pass: false, detail: "No heading/main landmark or substantial body text in DOM." };
    }
    case "ASSERT:NAV_OR_LINKS": {
      const ok =
        /<nav\b/i.test(html) ||
        /role=["']navigation["']/i.test(html) ||
        /<a\s+[^>]*href=/i.test(html) ||
        /<button\b/i.test(html) ||
        /role=["']button["']/i.test(html);
      return ok
        ? { pass: true, detail: "Found nav, links, or buttons." }
        : { pass: false, detail: "No nav, links, or buttons found." };
    }
    case "ASSERT:NOT_FOUND_OR_ERROR": {
      const code = page.httpCode;
      if (code !== undefined && code >= 400) {
        return { pass: true, detail: `HTTP ${code} for unknown path.` };
      }
      const notFoundish =
        /\b404\b/i.test(html) ||
        /not\s*found/i.test(html) ||
        /page\s+doesn'?t\s+exist/i.test(html) ||
        /does\s+not\s+exist/i.test(html);
      if (notFoundish) {
        return { pass: true, detail: "Body indicates not-found." };
      }
      // Soft SPA/CDN: unknown path must not look identical to home markup.
      if (homePage?.html && page.html && page.html.replace(/\s+/g, "") === homePage.html.replace(/\s+/g, "")) {
        return {
          pass: false,
          detail: "Unknown path returned the same markup as home (no 404 signal).",
        };
      }
      if (code !== undefined && code >= 200 && code < 400) {
        return {
          pass: false,
          detail: `Unknown path returned HTTP ${code} without a not-found signal.`,
        };
      }
      return { pass: false, detail: "Could not confirm error/not-found for unknown path." };
    }
    default:
      return {
        pass:
          lower.includes(kind.toLowerCase()) ||
          kind
            .toLowerCase()
            .split(/\s+/)
            .some((w) => w.length > 4 && lower.includes(w)),
        detail: `Literal expected hint: ${kind}`,
      };
  }
}

function attachWebFailScreenshot(
  result: CaseResult,
  chrome: string | undefined,
  url: string,
): CaseResult {
  if (result.status !== "fail") return result;
  if (!chrome) {
    return {
      ...result,
      screenshot_blocked_reason: "Chrome binary missing; curl fallback cannot capture screenshots.",
      logs: redactLogLines([
        ...(result.logs ?? []),
        "screenshot=blocked reason=chrome_missing_curl_fallback",
      ]),
    };
  }
  const shot = captureChromeScreenshot(chrome, url);
  if (shot.ok) {
    const screenshot: FailureScreenshot = {
      mime: shot.mime,
      base64: shot.base64,
      source: shot.source,
      bytes: shot.bytes,
    };
    return {
      ...result,
      screenshot,
      logs: redactLogLines([...(result.logs ?? []), `screenshot=ok source=${shot.source} bytes=${shot.bytes}`]),
    };
  }
  return {
    ...result,
    screenshot_blocked_reason: shot.blocked_reason,
    logs: redactLogLines([...(result.logs ?? []), `screenshot=blocked reason=${shot.blocked_reason}`]),
  };
}

export async function runWebCases(
  base_url: string,
  cases: NormalizedCase[],
  opts?: { auth?: ResolvedAuth | null },
): Promise<{
  ok: boolean;
  error?: string;
  fetch_via?: string;
  results: CaseResult[];
}> {
  const chrome = findChrome();

  const cache = new Map<string, PageFetch>();
  const getPage = (url: string): PageFetch => {
    const hit = cache.get(url);
    if (hit) return hit;
    const page = fetchPage(chrome, url);
    cache.set(url, page);
    return page;
  };

  const homePage = getPage(base_url);
  if (!homePage.ok) {
    return {
      ok: false,
      error: homePage.error ?? "Failed to load base_url.",
      fetch_via: homePage.via,
      results: cases.map((c) => ({
        test_id: c.test_id,
        status: "blocked" as const,
        blocked_reason: `Could not load ${base_url}: ${homePage.error ?? "empty DOM"}`,
        logs: redactLogLines([...homePage.log, `case=${c.test_id}`, "status=blocked"]),
      })),
    };
  }

  let sessionCookie: string | undefined;
  let validLogin: (LoginAttemptResult & { via?: string }) | undefined;
  const auth = opts?.auth ?? null;
  const results: CaseResult[] = [];

  for (const c of cases) {
    const expected = (c.expected_result ?? "").trim();
    const targetUrl = urlFromSteps(c.steps, base_url);

    if (expected.startsWith("ASSERT:LOGIN_") || expected.startsWith("ASSERT:AUTH_") || expected === "ASSERT:LOGOUT_AFFORDANCE") {
      if (!auth) {
        results.push({
          test_id: c.test_id,
          status: "blocked",
          blocked_reason: "Auth case requires credentials via env/secret refs (never paste secrets into logs/PDF).",
          logs: redactLogLines([`case=${c.test_id}`, "status=blocked", "auth=missing"]),
        });
        continue;
      }
      if (expected === "ASSERT:LOGIN_VALID") {
        validLogin = await attemptLoginBestEffort(base_url, auth, "valid");
        sessionCookie = validLogin.cookieHeader;
        const baseLogs = redactLogLines([
          ...validLogin.log,
          `case=${c.test_id}`,
          "assert=ASSERT:LOGIN_VALID",
          `login_via=${validLogin.via ?? "unknown"}`,
        ]);
        if (validLogin.ok) {
          results.push({
            test_id: c.test_id,
            status: "pass",
            evidence: [validLogin.detail],
            logs: [...baseLogs, "status=pass"],
          });
        } else {
          results.push(
            attachWebFailScreenshot(
              {
                test_id: c.test_id,
                status: "fail",
                evidence: [validLogin.htmlExcerpt].filter(Boolean),
                failure_analysis: validLogin.detail,
                logs: [...baseLogs, "status=fail"],
                screenshot_blocked_reason:
                  validLogin.via === "curl-form"
                    ? "curl form-login; Chrome screenshot skipped."
                    : undefined,
              },
              chrome,
              auth.login_url || base_url,
            ),
          );
        }
        continue;
      }
      if (expected === "ASSERT:LOGIN_INVALID") {
        const bad = await attemptLoginBestEffort(base_url, auth, "invalid");
        const baseLogs = redactLogLines([
          ...bad.log,
          `case=${c.test_id}`,
          "assert=ASSERT:LOGIN_INVALID",
          `login_via=${bad.via ?? "unknown"}`,
        ]);
        if (bad.ok) {
          results.push({
            test_id: c.test_id,
            status: "pass",
            evidence: [bad.detail],
            logs: [...baseLogs, "status=pass"],
          });
        } else {
          results.push({
            test_id: c.test_id,
            status: "fail",
            failure_analysis: bad.detail,
            logs: [...baseLogs, "status=fail"],
            screenshot_blocked_reason:
              bad.via === "curl-form" ? "curl form-login; Chrome screenshot skipped." : undefined,
          });
        }
        continue;
      }
      if (!validLogin) {
        validLogin = await attemptLoginBestEffort(base_url, auth, "valid");
        sessionCookie = validLogin.cookieHeader;
      }
      if (expected === "ASSERT:AUTH_SESSION") {
        const page = fetchWithCookie(base_url, sessionCookie);
        const baseLogs = redactLogLines([...page.log, `case=${c.test_id}`, "assert=ASSERT:AUTH_SESSION"]);
        const ok = page.ok && (page.httpCode ?? 200) < 400;
        results.push(
          ok
            ? {
                test_id: c.test_id,
                status: "pass",
                evidence: [`Authenticated fetch of home returned HTTP ${page.httpCode ?? "ok"}.`],
                logs: [...baseLogs, "status=pass"],
              }
            : {
                test_id: c.test_id,
                status: "fail",
                failure_analysis: "Authenticated session could not load home after login.",
                logs: [...baseLogs, "status=fail"],
              },
        );
        continue;
      }
      if (expected === "ASSERT:LOGOUT_AFFORDANCE") {
        const page = fetchWithCookie(base_url, sessionCookie);
        const html = page.html || validLogin?.htmlExcerpt || "";
        const baseLogs = redactLogLines([...page.log, `case=${c.test_id}`, "assert=ASSERT:LOGOUT_AFFORDANCE"]);
        const ok = /logout|sign[\s-]*out|log[\s-]*out/i.test(html);
        results.push(
          ok
            ? {
                test_id: c.test_id,
                status: "pass",
                evidence: ["Found logout/sign-out affordance in authenticated HTML."],
                logs: [...baseLogs, "status=pass"],
              }
            : {
                test_id: c.test_id,
                status: "fail",
                failure_analysis:
                  "No logout/sign-out affordance detected after login (SPA may hide it without JS).",
                logs: [...baseLogs, "status=fail"],
              },
        );
        continue;
      }
    }

    const page = getPage(targetUrl);
    const baseLogs = redactLogLines([
      ...page.log,
      `case=${c.test_id}`,
      `name=${c.test_case_name}`,
      `url=${targetUrl}`,
      `steps=${c.steps.join(" | ")}`,
      `expected=${expected}`,
      `fetch_via=${page.via}`,
    ]);
    if (c.app_type === "mobile") {
      results.push({
        test_id: c.test_id,
        status: "not_run",
        blocked_reason: "Case targets mobile; use mobile platform.",
        logs: [...baseLogs, "routed=mobile"],
      });
      continue;
    }
    if (!page.ok && !expected.startsWith("ASSERT:NOT_FOUND")) {
      results.push({
        test_id: c.test_id,
        status: "blocked",
        blocked_reason: `Could not load ${targetUrl}: ${page.error ?? "empty"}`,
        logs: [...baseLogs, "status=blocked"],
      });
      continue;
    }
    const navSteps = c.steps.filter(looksLikeNavStep);
    const actionable = c.steps.filter((s) => !looksLikeNavStep(s));
    const evidence = [
      `Loaded ${targetUrl} via ${page.via}${page.httpCode ? ` HTTP ${page.httpCode}` : ""}`,
      `DOM excerpt: ${page.excerpt.slice(0, 120)}`,
      ...(page.error ? [page.error] : []),
    ];
    const verifyOnly =
      actionable.length === 0 ||
      actionable.every((s) => /verify|assert|check|see|confirm|submit/i.test(s));
    if (expected && verifyOnly) {
      const asserted = evalAssert(expected, page, homePage);
      if (asserted.pass) {
        results.push({
          test_id: c.test_id,
          status: "pass",
          evidence: [...evidence, asserted.detail],
          logs: [...baseLogs, "status=pass", `assert=${expected}`, asserted.detail],
        });
      } else {
        results.push(
          attachWebFailScreenshot(
            {
              test_id: c.test_id,
              status: "fail",
              evidence,
              failure_analysis: asserted.detail,
              logs: [...baseLogs, "status=fail", `assert=${expected}`, asserted.detail],
            },
            chrome,
            targetUrl,
          ),
        );
      }
      continue;
    }
    if (actionable.some((s) => /(click|type|enter|select|tap|fill|submit|login)/i.test(s))) {
      results.push({
        test_id: c.test_id,
        status: "blocked",
        evidence,
        blocked_reason:
          "Case requires interactive steps without explicit selectors in the sheet/brief. Do not invent UI.",
        logs: [...baseLogs, "status=blocked", "reason=interactive_without_selectors"],
      });
      continue;
    }
    if (!expected && navSteps.length > 0) {
      results.push({
        test_id: c.test_id,
        status: "pass",
        evidence: [...evidence, "Navigation-only case; page loaded."],
        logs: [...baseLogs, "status=pass", "assert=nav_only"],
      });
      continue;
    }
    results.push({
      test_id: c.test_id,
      status: "not_run",
      evidence,
      blocked_reason: "Insufficient automation detail in steps/expected_result for Chrome execution.",
      logs: [...baseLogs, "status=not_run"],
    });
  }

  return { ok: true, fetch_via: homePage.via, results };
}

function runCmd(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000 });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function probeAndroid(emulator_id?: string): {
  available: boolean;
  devices: string[];
  detail: string;
  log: string[];
} {
  if (!runCmd("which", ["adb"]).ok) {
    return {
      available: false,
      devices: [],
      detail: "adb not found. Wire this on a local/self-hosted worker with Android SDK.",
      log: ["adb=missing"],
    };
  }
  const devices = runCmd("adb", ["devices"]);
  const lines = devices.stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("*"));
  const online = lines.filter((l) => /\tdevice\b/.test(l)).map((l) => l.split(/\s+/)[0]!);
  const log = [`adb=present`, `online=${online.join(",") || "(none)"}`];
  if (emulator_id && !online.includes(emulator_id)) {
    return {
      available: false,
      devices: online,
      detail: `Requested emulator_id ${emulator_id} not online.`,
      log: [...log, `requested=${emulator_id}`],
    };
  }
  return {
    available: online.length > 0,
    devices: online,
    detail: online.length ? `Android devices online: ${online.join(", ")}` : "No Android emulator online.",
    log,
  };
}

function probeIos(emulator_id?: string): {
  available: boolean;
  devices: string[];
  detail: string;
  log: string[];
} {
  if (!runCmd("which", ["xcrun"]).ok) {
    return {
      available: false,
      devices: [],
      detail: "xcrun not found. iOS simulation requires macOS with Xcode.",
      log: ["xcrun=missing"],
    };
  }
  const list = runCmd("xcrun", ["simctl", "list", "devices", "booted"]);
  const booted = [...list.stdout.matchAll(/\(([-A-F0-9]+)\)\s+\(Booted\)/gi)].map((m) => m[1]!);
  const log = [`xcrun=present`, `booted=${booted.join(",") || "(none)"}`];
  if (emulator_id && !booted.includes(emulator_id) && !list.stdout.includes(emulator_id)) {
    return {
      available: false,
      devices: booted,
      detail: `Requested iOS simulator ${emulator_id} not booted.`,
      log: [...log, `requested=${emulator_id}`],
    };
  }
  return {
    available: booted.length > 0 || /Booted/.test(list.stdout),
    devices: booted,
    detail: booted.length ? `Booted iOS simulators: ${booted.join(", ")}` : "No booted iOS simulator.",
    log,
  };
}

export function runMobileCases(
  platform: MobilePlatform,
  cases: NormalizedCase[],
  opts?: { package_or_bundle?: string; emulator_id?: string; require_live_emulator?: boolean },
): { ok: boolean; emulator_available: boolean; detail: string; results: CaseResult[] } {
  const probe = platform === "android" ? probeAndroid(opts?.emulator_id) : probeIos(opts?.emulator_id);
  const requireLive = opts?.require_live_emulator === true;
  if (!probe.available) {
    const blocked_reason = requireLive
      ? probe.detail
      : `${probe.detail} Mobile execution is stubbed for this host; run on the self-hosted worker that hosts the emulator.`;
    return {
      ok: !requireLive,
      emulator_available: false,
      detail: probe.detail,
      results: cases.map((c) => ({
        test_id: c.test_id,
        status: "blocked" as const,
        blocked_reason,
        logs: redactLogLines([...probe.log, `platform=${platform}`, `case=${c.test_id}`, "status=blocked"]),
      })),
    };
  }

  const results = cases.map((c) => {
    const baseLogs = redactLogLines([
      ...probe.log,
      `platform=${platform}`,
      `case=${c.test_id}`,
      `name=${c.test_case_name}`,
      `steps=${c.steps.join(" | ")}`,
      `package=${opts?.package_or_bundle ?? ""}`,
    ]);
    if (c.app_type === "web") {
      return {
        test_id: c.test_id,
        status: "not_run" as const,
        blocked_reason: "Case targets web; use web platform.",
        logs: [...baseLogs, "status=not_run", "routed=web"],
      };
    }
    const interactive = c.steps.some((s) => /(tap|click|type|enter|swipe|launch|open app)/i.test(s));
    if (interactive) {
      return {
        test_id: c.test_id,
        status: "blocked" as const,
        evidence: [`Emulator probe ok: ${probe.detail}`],
        blocked_reason:
          "Emulator reachable, but no automation stack is configured yet (Appium/Maestro/etc).",
        logs: [...baseLogs, "status=blocked", "reason=no_automation_stack"],
      };
    }
    const expected = (c.expected_result ?? "").trim();
    if (expected && !/probe|online|device|booted/i.test(expected)) {
      const shot =
        platform === "android"
          ? captureAndroidScreenshot(opts?.emulator_id)
          : captureIosScreenshot(opts?.emulator_id);
      const base: CaseResult = {
        test_id: c.test_id,
        status: "fail",
        evidence: [`Emulator probe ok: ${probe.detail}`],
        failure_analysis: `Expected UI result "${expected}" could not be verified without an automation stack.`,
        logs: [...baseLogs, "status=fail", "reason=expected_without_automation"],
      };
      if (shot.ok) {
        return {
          ...base,
          screenshot: {
            mime: shot.mime,
            base64: shot.base64,
            source: shot.source,
            bytes: shot.bytes,
          },
          logs: redactLogLines([...(base.logs ?? []), `screenshot=ok source=${shot.source}`]),
        };
      }
      return {
        ...base,
        screenshot_blocked_reason: shot.blocked_reason,
        logs: redactLogLines([...(base.logs ?? []), `screenshot=blocked reason=${shot.blocked_reason}`]),
      };
    }
    return {
      test_id: c.test_id,
      status: "pass" as const,
      evidence: [`Emulator probe ok: ${probe.detail}`, "Non-interactive / probe-only case."],
      logs: [...baseLogs, "status=pass", "assert=probe_only"],
    };
  });

  return { ok: true, emulator_available: true, detail: probe.detail, results };
}
