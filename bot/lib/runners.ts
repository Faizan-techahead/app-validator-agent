import { spawnSync } from "node:child_process";
import { redactLogLines } from "./redact";
import { captureAndroidScreenshot, captureChromeScreenshot, captureIosScreenshot } from "./screenshots";
import type { CaseResult, FailureScreenshot, MobilePlatform, NormalizedCase } from "./types";

function findChrome(): string | undefined {
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const which = spawnSync("which", [bin], { encoding: "utf8" });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  }
  return undefined;
}

function fetchViaCurl(url: string): { ok: boolean; excerpt: string; error?: string; log: string[] } {
  const result = spawnSync(
    "curl",
    ["-fsSL", "--max-time", "15", "-A", "app-validator-chrome-fallback/1.0", "-w", "\nHTTP_CODE:%{http_code}", url],
    { encoding: "utf8", maxBuffer: 5_000_000 },
  );
  const log = [
    `curl ${url}`,
    `exit=${result.status}`,
    result.stderr ? `stderr=${result.stderr.slice(0, 300)}` : "",
  ].filter(Boolean);
  if (result.error) {
    return { ok: false, excerpt: "", error: result.error.message, log: [...log, result.error.message] };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      excerpt: (result.stderr || "").slice(0, 500),
      error: `curl exited ${result.status}`,
      log,
    };
  }
  const raw = result.stdout ?? "";
  const codeMatch = /HTTP_CODE:(\d+)\s*$/.exec(raw);
  const html = codeMatch ? raw.slice(0, codeMatch.index) : raw;
  return {
    ok: html.length > 0,
    excerpt: html.replace(/\s+/g, " ").slice(0, 1200),
    log: [...log, `http_code=${codeMatch?.[1] ?? "unknown"}`, `body_bytes≈${html.length}`],
  };
}

function fetchPage(chrome: string, url: string): {
  ok: boolean;
  excerpt: string;
  error?: string;
  via: "chrome" | "curl";
  log: string[];
} {
  const result = spawnSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--no-first-run",
      "--virtual-time-budget=3000",
      "--timeout=10000",
      "--dump-dom",
      url,
    ],
    { encoding: "utf8", maxBuffer: 5_000_000, timeout: 20_000 },
  );
  const chromeLog = [
    `chrome --dump-dom ${url}`,
    `exit=${result.status}`,
    result.error ? `error=${result.error.message}` : "",
    result.stderr ? `stderr=${result.stderr.slice(0, 300)}` : "",
  ].filter(Boolean);
  if (!result.error && result.status === 0 && (result.stdout ?? "").length > 0) {
    return {
      ok: true,
      excerpt: (result.stdout ?? "").replace(/\s+/g, " ").slice(0, 1200),
      via: "chrome",
      log: [...chromeLog, `dom_bytes≈${(result.stdout ?? "").length}`],
    };
  }
  const chromeError =
    result.error?.message ?? ((result.stderr || "").trim() || `Chrome exited ${result.status}`);
  const fallback = fetchViaCurl(url);
  if (fallback.ok) {
    return {
      ok: true,
      excerpt: fallback.excerpt,
      error: `Chrome unavailable (${chromeError}); used curl HTML fallback.`,
      via: "curl",
      log: [...chromeLog, ...fallback.log, "fallback=curl"],
    };
  }
  return {
    ok: false,
    excerpt: "",
    error: `Chrome: ${chromeError}; curl: ${fallback.error ?? "failed"}`,
    via: "chrome",
    log: [...chromeLog, ...fallback.log],
  };
}

function looksLikeNavStep(step: string): boolean {
  return /^(open|goto|go to|navigate|visit|load)\b/i.test(step.trim());
}

function attachWebFailScreenshot(result: CaseResult, chrome: string, url: string): CaseResult {
  if (result.status !== "fail") return result;
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

export function runWebCases(base_url: string, cases: NormalizedCase[]): {
  ok: boolean;
  error?: string;
  fetch_via?: string;
  results: CaseResult[];
} {
  const chrome = findChrome();
  if (!chrome) {
    return {
      ok: false,
      error: "Chrome binary not found on this host.",
      results: cases.map((c) => ({
        test_id: c.test_id,
        status: "blocked" as const,
        blocked_reason: "Chrome binary not available on this worker.",
        logs: redactLogLines([`chrome=missing`, `case=${c.test_id}`]),
      })),
    };
  }

  const page = fetchPage(chrome, base_url);
  if (!page.ok) {
    return {
      ok: false,
      error: page.error ?? "Failed to load base_url.",
      fetch_via: page.via,
      results: cases.map((c) => ({
        test_id: c.test_id,
        status: "blocked" as const,
        blocked_reason: `Could not load ${base_url}: ${page.error ?? "empty DOM"}`,
        logs: redactLogLines([...page.log, `case=${c.test_id}`, "status=blocked"]),
      })),
    };
  }

  const results = cases.map((c) => {
    const baseLogs = redactLogLines([
      ...page.log,
      `case=${c.test_id}`,
      `name=${c.test_case_name}`,
      `steps=${c.steps.join(" | ")}`,
      `expected=${c.expected_result ?? ""}`,
      `fetch_via=${page.via}`,
    ]);
    if (c.app_type === "mobile") {
      return {
        test_id: c.test_id,
        status: "not_run" as const,
        blocked_reason: "Case targets mobile; use mobile platform.",
        logs: [...baseLogs, "routed=mobile"],
      };
    }
    const navSteps = c.steps.filter(looksLikeNavStep);
    const actionable = c.steps.filter((s) => !looksLikeNavStep(s));
    const evidence = [
      `Loaded ${base_url} via ${page.via}`,
      `DOM excerpt: ${page.excerpt.slice(0, 120)}`,
      ...(page.error ? [page.error] : []),
    ];
    const expected = (c.expected_result ?? "").trim();
    const verifyOnly =
      actionable.length === 0 ||
      actionable.every((s) => /verify|assert|check|see|confirm/i.test(s));
    if (expected && verifyOnly) {
      const needle = expected.toLowerCase();
      const hay = page.excerpt.toLowerCase();
      const matched =
        hay.includes(needle) ||
        needle.split(/\s+/).some((w) => w.length > 4 && hay.includes(w));
      if (matched) {
        return {
          test_id: c.test_id,
          status: "pass" as const,
          evidence: [...evidence, `Expected hint matched: ${expected}`],
          logs: [...baseLogs, "status=pass", "assert=matched"],
        };
      }
      return attachWebFailScreenshot(
        {
          test_id: c.test_id,
          status: "fail",
          evidence,
          failure_analysis: `Expected result text not found in page DOM excerpt: "${expected}"`,
          logs: [...baseLogs, "status=fail", "assert=missing_expected"],
        },
        chrome,
        base_url,
      );
    }
    if (actionable.some((s) => /(click|type|enter|select|tap|fill|submit|login)/i.test(s))) {
      return {
        test_id: c.test_id,
        status: "blocked" as const,
        evidence,
        blocked_reason:
          "Case requires interactive steps without explicit selectors in the sheet/brief. Do not invent UI.",
        logs: [...baseLogs, "status=blocked", "reason=interactive_without_selectors"],
      };
    }
    if (!expected && navSteps.length > 0) {
      return {
        test_id: c.test_id,
        status: "pass" as const,
        evidence: [...evidence, "Navigation-only case; page loaded."],
        logs: [...baseLogs, "status=pass", "assert=nav_only"],
      };
    }
    return {
      test_id: c.test_id,
      status: "not_run" as const,
      evidence,
      blocked_reason: "Insufficient automation detail in steps/expected_result for Chrome execution.",
      logs: [...baseLogs, "status=not_run"],
    };
  });

  return { ok: true, fetch_via: page.via, results };
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
