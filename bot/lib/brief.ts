import type { ApplicationBrief } from "./types";

export type BriefValidation = {
  ok: boolean;
  brief: ApplicationBrief;
  issues: string[];
};

export function validateBrief(input: ApplicationBrief): BriefValidation {
  const issues: string[] = [];
  const brief: ApplicationBrief = {
    ...input,
    app_name: input.app_name.trim(),
  };

  if (
    (brief.app_type === "web" || brief.app_type === "hybrid") &&
    !brief.base_url &&
    !(brief.environments ?? []).some((e) => e.url)
  ) {
    issues.push("web/hybrid brief needs base_url or an environment url.");
  }
  if (brief.app_type === "mobile" && !brief.mobile?.platform) {
    issues.push(
      "mobile brief should include mobile.platform, or pass mobile_os on the API request.",
    );
  }

  const secretSmell = JSON.stringify(brief).match(
    /(password|api[_-]?key|secret|token|bearer)\s*[:=]/i,
  );
  if (secretSmell) {
    return {
      ok: false,
      brief,
      issues: [
        ...issues,
        "Brief appears to contain secret-like fields. Use auth_secret_refs only; never paste secrets.",
      ],
    };
  }

  return { ok: issues.length === 0, brief, issues };
}
