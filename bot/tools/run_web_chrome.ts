import { spawnSync } from "node:child_process";
import { prompt } from "@grok/agent-sdk";
import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { findChromeBinary } from "../lib/chrome";
import { redactLogLines } from "../lib/redact";
import { captureChromeScreenshot } from "../lib/screenshots";
import type { CaseResult, FailureScreenshot, NormalizedCase } from "../lib/types";

const CaseSchema = z.object({
  test_id: z.string(),
  test_case_name: z.string(),
  steps: z.array(z.string()),
  expected_result: z.string().optional(),
  preconditions: z.string().optional(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  app_type: z.enum(["web", "mobile", "hybrid", "api", "docs_only"]).optional(),
  source: z.enum(["excel", "generated", "brief"]),
});

function findChrome(): string | undefined {
  return findChromeBinary();
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
  const httpCode = codeMatch?.[1] ?? "unknown";
  return {
    ok: html.length > 0,
    excerpt: html.replace(/\s+/g, " ").slice(0, 1200),
    log: [...log, `http_code=${httpCode}`, `body_bytes≈${html.length}`],
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
    result.error?.message ??
    ((result.stderr || "").trim() || `Chrome exited ${result.status}`);
  const fallback = fetchViaCurl(url);
  if (fallback.ok) {
    return {
      ok: true,
      excerpt: fallback.excerpt,
      error: `Chrome unavailable (${chromeError}); used curl HTML fallback.`,
      via: "curl",
      log: [...chromeLog, ...fallback.log, `fallback=curl`],
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

function attachFailScreenshot(
  result: CaseResult,
  chrome: string,
  url: string,
): CaseResult {
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
      logs: redactLogLines([
        ...(result.logs ?? []),
        `screenshot=ok source=${shot.source} bytes=${shot.bytes}`,
      ]),
    };
  }
  return {
    ...result,
    screenshot_blocked_reason: shot.blocked_reason,
    logs: redactLogLines([
      ...(result.logs ?? []),
      `screenshot=blocked reason=${shot.blocked_reason}`,
    ]),
  };
}

export default defineTool({
  description: prompt`
    Run web validation cases against base_url using Chrome headless.
    Collects redacted per-case execution logs. On Fail, captures a page screenshot
    (Chrome --screenshot); if capture fails, records screenshot_blocked_reason.
    Does not invent selectors. Marks incomplete automation as blocked or not_run.
  `,
  effect: "idempotent",
  inputSchema: z.object({
    base_url: z.string().url(),
    cases: z.array(CaseSchema),
    dry_check_only: z
      .boolean()
      .optional()
      .describe("When true, only verify Chrome + URL reachability without scoring every case."),
  }),
  async execute({ base_url, cases, dry_check_only }) {
    const chrome = findChrome();
    if (!chrome) {
      return {
        ok: false as const,
        error: "Chrome binary not found on this host.",
        results: cases.map(
          (c): CaseResult => ({
            test_id: c.test_id,
            status: "blocked",
            blocked_reason: "Chrome binary not available on this worker.",
            logs: redactLogLines([`chrome=missing`, `case=${c.test_id}`]),
          }),
        ),
      };
    }

    const page = fetchPage(chrome, base_url);
    if (dry_check_only) {
      return {
        ok: page.ok,
        chrome,
        base_url,
        page_ok: page.ok,
        fetch_via: page.via,
        excerpt: page.excerpt,
        error: page.error,
        results: [] as CaseResult[],
      };
    }

    if (!page.ok) {
      return {
        ok: false as const,
        chrome,
        fetch_via: page.via,
        error: page.error ?? "Failed to load base_url in Chrome.",
        results: cases.map(
          (c): CaseResult => ({
            test_id: c.test_id,
            status: "blocked",
            blocked_reason: `Could not load ${base_url}: ${page.error ?? "empty DOM"}`,
            logs: redactLogLines([
              ...page.log,
              `case=${c.test_id}`,
              `status=blocked`,
            ]),
          }),
        ),
      };
    }

    const results: CaseResult[] = cases.map((c: NormalizedCase) => {
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
          status: "not_run",
          blocked_reason: "Case targets mobile; use run_mobile_emulator.",
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
        return attachFailScreenshot(
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

    return {
      ok: true as const,
      chrome,
      base_url,
      page_ok: true,
      fetch_via: page.via,
      results,
    };
  },
});
