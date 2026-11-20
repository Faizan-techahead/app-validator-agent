import { prompt } from "@grok/agent-sdk";
import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import type { NormalizedCase } from "../lib/types";
import { fingerprintPayload } from "../lib/pdf";

const CaseSchema = z.object({
  test_id: z.string().optional(),
  test_case_name: z.string(),
  steps: z.array(z.string()).min(1),
  expected_result: z.string().optional(),
  preconditions: z.string().optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  app_type: z.enum(["web", "mobile", "hybrid", "api", "docs_only"]).optional(),
  source: z.enum(["excel", "generated", "brief"]).optional(),
});

export default defineTool({
  description: prompt`
    Merge Excel-imported cases with optional gap cases justified by the brief.
    Gap cases must be labeled source=generated and must not invent UI or APIs
    that are absent from the brief or sheet. Assigns stable test_id values.
  `,
  effect: "idempotent",
  inputSchema: z.object({
    excel_cases: z.array(CaseSchema).default([]),
    gap_cases: z.array(CaseSchema).default([]),
    app_name: z.string().optional(),
  }),
  async execute({ excel_cases, gap_cases, app_name }, ctx) {
    const normalize = (
      c: z.infer<typeof CaseSchema>,
      index: number,
      sourceDefault: NormalizedCase["source"],
    ): NormalizedCase => {
      const source = c.source ?? sourceDefault;
      const test_id =
        c.test_id?.trim() ||
        `tc_${source}_${String(index + 1).padStart(3, "0")}_${c.test_case_name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .slice(0, 32)}`;
      return {
        test_id,
        test_case_name: c.test_case_name.trim(),
        steps: c.steps.map((s) => s.trim()).filter(Boolean),
        expected_result: c.expected_result?.trim() || undefined,
        preconditions: c.preconditions?.trim() || undefined,
        severity: c.severity ?? "medium",
        app_type: c.app_type,
        source,
      };
    };

    const catalog: NormalizedCase[] = [
      ...excel_cases.map((c, i) => normalize(c, i, "excel")),
      ...gap_cases.map((c, i) => normalize({ ...c, source: c.source ?? "generated" }, i, "generated")),
    ];

    const seen = new Set<string>();
    for (const c of catalog) {
      if (seen.has(c.test_id)) {
        return {
          ok: false as const,
          error: `Duplicate test_id: ${c.test_id}`,
        };
      }
      seen.add(c.test_id);
      if (c.steps.length === 0) {
        return {
          ok: false as const,
          error: `Case ${c.test_id} has no steps.`,
        };
      }
    }

    const fingerprint = fingerprintPayload({ app_name, catalog });
    const key = `catalog:${ctx.session.id}`;
    await ctx.host.kv?.put(key, { fingerprint, catalog, app_name: app_name ?? null });

    return {
      ok: true as const,
      catalog_id: key,
      fingerprint,
      case_count: catalog.length,
      excel_count: catalog.filter((c) => c.source === "excel").length,
      generated_count: catalog.filter((c) => c.source === "generated").length,
      catalog,
    };
  },
});
