import { prompt } from "@grok/agent-sdk";
import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import type { ApplicationBrief } from "../lib/types";

const BriefSchema = z.object({
  app_name: z.string().min(1),
  app_type: z.enum(["web", "mobile", "hybrid", "api", "docs_only"]),
  base_url: z.string().url().optional(),
  mobile: z
    .object({
      platform: z.enum(["android", "ios"]).optional(),
      package_or_bundle: z.string().optional(),
      emulator_id: z.string().optional(),
    })
    .optional(),
  environments: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().optional(),
      }),
    )
    .optional(),
  roles: z.array(z.string()).optional(),
  critical_flows: z.array(z.string()).optional(),
  auth_secret_refs: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  in_scope: z.array(z.string()).optional(),
  out_of_scope: z.array(z.string()).optional(),
});

export default defineTool({
  description: prompt`
    Parse and validate an application brief.
    Rejects secrets in the brief body. Does not invent missing URLs or UI.
  `,
  effect: "read",
  inputSchema: z.object({
    brief: BriefSchema,
  }),
  async execute({ brief }) {
    const issues: string[] = [];
    if (
      (brief.app_type === "web" || brief.app_type === "hybrid") &&
      !brief.base_url &&
      !(brief.environments ?? []).some((e) => e.url)
    ) {
      issues.push("web/hybrid brief needs base_url or an environment url.");
    }
    if (brief.app_type === "mobile" && !brief.mobile?.platform) {
      issues.push(
        "mobile brief should include mobile.platform, or ask the user Android vs iOS at run time before execute.",
      );
    }

    const secretSmell = JSON.stringify(brief).match(
      /(password|api[_-]?key|secret|token|bearer)\s*[:=]/i,
    );
    if (secretSmell) {
      return {
        ok: false as const,
        error:
          "Brief appears to contain secret-like fields. Use auth_secret_refs only; never paste secrets.",
        issues,
      };
    }

    const normalized: ApplicationBrief = {
      ...brief,
      app_name: brief.app_name.trim(),
    };

    return {
      ok: issues.length === 0,
      brief: normalized,
      issues,
      next:
        issues.length === 0
          ? "Import Excel cases (if any), then generate_test_catalog."
          : "Ask the user to fill missing brief fields before execution.",
    };
  },
});
