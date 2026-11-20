import { prompt } from "@grok/agent-sdk";
import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { fingerprintPayload, nowIstIso } from "../lib/pdf";
import { redactLogLines } from "../lib/redact";
import type { CaseResult, CaseStatus, NormalizedCase, ValidationSuiteResult } from "../lib/types";

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

const ScreenshotSchema = z.object({
  mime: z.enum(["image/png", "image/jpeg"]),
  base64: z.string().min(1),
  source: z.string().optional(),
  bytes: z.number().optional(),
});

const ResultSchema = z.object({
  test_id: z.string(),
  status: z.enum(["pass", "fail", "blocked", "not_run"]),
  evidence: z.array(z.string()).optional(),
  failure_analysis: z.string().optional(),
  blocked_reason: z.string().optional(),
  logs: z.array(z.string()).optional(),
  screenshot: ScreenshotSchema.optional(),
  screenshot_blocked_reason: z.string().optional(),
});

function emptySummary() {
  return { pass: 0, fail: 0, blocked: 0, not_run: 0, total: 0 };
}

export default defineTool({
  description: prompt`
    Orchestrate scoring for a validation run: merge catalog cases with runner
    results (including redacted logs and failure screenshots), compute
    Pass/Fail/Blocked/Not Run counts, and attach failure analysis.
    Deterministic. Absent runner output becomes not_run.
  `,
  effect: "idempotent",
  inputSchema: z.object({
    app_name: z.string(),
    platform: z.string(),
    environment: z.string().optional(),
    catalog: z.array(CaseSchema),
    results: z.array(ResultSchema),
    run_id: z.string().optional(),
  }),
  async execute({ app_name, platform, environment, catalog, results, run_id }, ctx) {
    const byId = new Map<string, CaseResult>(
      results.map((r) => [
        r.test_id,
        {
          ...r,
          logs: r.logs ? redactLogLines(r.logs) : undefined,
        },
      ]),
    );
    const summary = emptySummary();
    const merged: ValidationSuiteResult["cases"] = catalog.map((c: NormalizedCase) => {
      const r = byId.get(c.test_id);
      const status: CaseStatus = r?.status ?? "not_run";
      summary[status] += 1;
      summary.total += 1;
      const logs =
        r?.logs ??
        redactLogLines([
          `case=${c.test_id}`,
          "status=not_run",
          "reason=no_runner_result",
        ]);
      return {
        ...c,
        status,
        evidence: r?.evidence,
        failure_analysis: r?.failure_analysis,
        blocked_reason:
          r?.blocked_reason ??
          (r ? undefined : "No runner result for this case."),
        logs,
        screenshot: status === "fail" ? r?.screenshot : undefined,
        screenshot_blocked_reason:
          status === "fail"
            ? r?.screenshot_blocked_reason ??
              (r?.screenshot ? undefined : "No failure screenshot provided by runner.")
            : undefined,
      };
    });

    const suite: ValidationSuiteResult = {
      run_id: run_id ?? `run_${Date.now()}`,
      app_name,
      platform,
      timestamp_ist: nowIstIso(),
      environment,
      summary,
      cases: merged,
      input_fingerprint: fingerprintPayload({ app_name, platform, catalog }),
    };

    // Persist suite JSON without huge screenshot payloads in kv; keep screenshots in files JSON.
    const key = `suite:${ctx.session.id}:${suite.run_id}`;
    const suiteForKv = {
      ...suite,
      cases: suite.cases.map((c) => ({
        ...c,
        screenshot: c.screenshot
          ? {
              mime: c.screenshot.mime,
              source: c.screenshot.source,
              bytes: c.screenshot.bytes,
              base64: `[omitted ${c.screenshot.base64.length} chars]`,
            }
          : undefined,
      })),
    };
    await ctx.host.kv?.put(key, JSON.parse(JSON.stringify(suiteForKv)));
    await ctx.host.files.write(
      `reports/${suite.run_id}.json`,
      JSON.stringify(suite, null, 2),
      { scope: "deployment" },
    );

    return {
      ok: true as const,
      suite_key: key,
      report_json_path: `reports/${suite.run_id}.json`,
      suite,
      log_case_count: suite.cases.filter((c) => (c.logs?.length ?? 0) > 0).length,
      fail_screenshot_count: suite.cases.filter((c) => c.screenshot).length,
      fail_screenshot_blocked_count: suite.cases.filter((c) => c.screenshot_blocked_reason).length,
    };
  },
});
