import { runValidationPipeline, type PipelineResult } from "./pipeline";

export type SimpleValidateInput = {
  url: string;
  username?: string;
  password?: string;
  app_name?: string;
  pdf_mode?: "base64" | "path" | "both";
};

/** One-shot: URL (+ optional creds) → explore cases → Chrome → PDF. */
export async function runSimpleValidate(input: SimpleValidateInput): Promise<PipelineResult> {
  const url = input.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    return {
      ok: false,
      error: "url must start with http:// or https://",
      run_id: `run_${Date.now()}`,
      platform: "web",
    };
  }
  let host = "app";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* keep default */
  }
  const app_name = (input.app_name?.trim() || host || "App").slice(0, 80);
  const hasCreds = Boolean(input.username?.trim() && input.password);

  return runValidationPipeline({
    brief: {
      app_name,
      app_type: "web",
      base_url: url,
    },
    platform: "web",
    pdf_mode: input.pdf_mode ?? "path",
    login: hasCreds
      ? {
          username: input.username!.trim(),
          password: input.password!,
          login_url: url,
        }
      : undefined,
  });
}
