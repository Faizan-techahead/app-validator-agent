import { prompt } from "@grok/agent-sdk";
import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { loadTabularFile, rowsToCases } from "../lib/excel";
import { projectFixture, resolveSafePath } from "../lib/paths";

export default defineTool({
  description: prompt`
    Import test cases from an Excel (.xlsx), CSV, or JSON sheet.
    Map columns at runtime via columnMapping; do not assume a fixed corporate template.
    Returns normalized cases with stable test_id values.
  `,
  effect: "read",
  inputSchema: z.object({
    path: z
      .string()
      .describe(
        "Path to .xlsx/.csv/.json. Relative paths resolve from the session workspace, then project fixtures.",
      ),
    columnMapping: z
      .object({
        test_case_name: z.string().optional(),
        steps: z.string().optional(),
        expected_result: z.string().optional(),
        preconditions: z.string().optional(),
        severity: z.string().optional(),
        app_type: z.string().optional(),
        test_id: z.string().optional(),
      })
      .optional(),
  }),
  async execute({ path, columnMapping }, ctx) {
    const candidates = [
      resolveSafePath(path, ctx.workspaceDir),
      resolveSafePath(path, process.cwd()),
      projectFixture(path),
      projectFixture(path.replace(/^.*\//, "")),
    ];
    let filePath: string | undefined;
    for (const c of candidates) {
      try {
        loadTabularFile(c);
        filePath = c;
        break;
      } catch {
        // try next
      }
    }
    if (!filePath) {
      return {
        ok: false as const,
        error: `File not found or unreadable: ${path}`,
        tried: candidates,
      };
    }

    try {
      const { headers, rows, format } = loadTabularFile(filePath);
      const { cases, warnings, mapping_used } = rowsToCases(headers, rows, {
        mapping: columnMapping,
        source: "excel",
      });
      return {
        ok: true as const,
        format,
        path: filePath,
        headers,
        mapping_used,
        case_count: cases.length,
        cases,
        warnings,
      };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
        path: filePath,
      };
    }
  },
});
