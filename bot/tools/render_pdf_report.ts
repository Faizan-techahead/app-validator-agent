import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { prompt } from "@grok/agent-sdk";
import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { renderValidationPdf } from "../lib/pdf";
import type { ValidationSuiteResult } from "../lib/types";

const ScreenshotSchema = z.object({
  mime: z.enum(["image/png", "image/jpeg"]),
  base64: z.string().min(1),
  source: z.string().optional(),
  bytes: z.number().optional(),
});

const SuiteSchema = z.object({
  run_id: z.string(),
  app_name: z.string(),
  platform: z.string(),
  timestamp_ist: z.string(),
  environment: z.string().optional(),
  summary: z.object({
    pass: z.number(),
    fail: z.number(),
    blocked: z.number(),
    not_run: z.number(),
    total: z.number(),
  }),
  cases: z.array(
    z.object({
      test_id: z.string(),
      test_case_name: z.string(),
      steps: z.array(z.string()),
      expected_result: z.string().optional(),
      preconditions: z.string().optional(),
      severity: z.enum(["critical", "high", "medium", "low"]),
      app_type: z.enum(["web", "mobile", "hybrid", "api", "docs_only"]).optional(),
      source: z.enum(["excel", "generated", "brief"]),
      status: z.enum(["pass", "fail", "blocked", "not_run"]),
      evidence: z.array(z.string()).optional(),
      failure_analysis: z.string().optional(),
      blocked_reason: z.string().optional(),
      logs: z.array(z.string()).optional(),
      screenshot: ScreenshotSchema.optional(),
      screenshot_blocked_reason: z.string().optional(),
    }),
  ),
  input_fingerprint: z.string(),
});

export default defineTool({
  description: prompt`
    Render a deterministic PDF validation report from a scored suite.
    Same PDF includes cover, summary, coverage, case table, failure analysis,
    full redacted execution logs, embedded failure screenshots, gaps, and fingerprint.
    Never writes secrets into the PDF.
  `,
  effect: "idempotent",
  inputSchema: z.object({
    suite: SuiteSchema,
    output_path: z
      .string()
      .optional()
      .describe("Relative path under workspace/host files. Default reports/<run_id>.pdf"),
  }),
  async execute({ suite, output_path }, ctx) {
    const path = output_path ?? `reports/${suite.run_id}.pdf`;
    const bytes = renderValidationPdf(suite as ValidationSuiteResult);

    await ctx.host.files.write(path, bytes, { scope: "deployment" });

    const localDir = ctx.workspaceDir ?? process.cwd();
    const localPath = join(localDir, path);
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, bytes);

    // Also persist under the project cwd so tool-call smoke can inspect the PDF.
    const projectPath = join(process.cwd(), path);
    if (projectPath !== localPath) {
      mkdirSync(dirname(projectPath), { recursive: true });
      writeFileSync(projectPath, bytes);
    }

    return {
      ok: true as const,
      pdf_path: path,
      local_path: localPath,
      project_path: projectPath,
      bytes: bytes.byteLength,
      summary: suite.summary,
      input_fingerprint: suite.input_fingerprint,
      includes_logs: suite.cases.some((c) => (c.logs?.length ?? 0) > 0),
      embedded_failure_screenshots: suite.cases.filter((c) => c.screenshot).length,
      screenshot_blocked: suite.cases.filter((c) => c.screenshot_blocked_reason).length,
    };
  },
});
