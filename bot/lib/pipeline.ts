import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAuth, type AuthInput } from "./auth";
import { validateBrief } from "./brief";
import { generateExploreCases } from "./explore-cases";
import { loadTabularFile, rowsToCases } from "./excel";
import { fingerprintPayload, nowIstIso, renderValidationPdf } from "./pdf";
import { resolveSafePath } from "./paths";
import { redactLogLines } from "./redact";
import { runMobileCases, runWebCases } from "./runners";
import type {
  ApplicationBrief,
  CaseResult,
  CaseStatus,
  ColumnMapping,
  MobilePlatform,
  NormalizedCase,
  ValidationSuiteResult,
} from "./types";

export type PipelineInput = {
  brief: ApplicationBrief;
  /** Override routing: web | mobile (defaults from brief.app_type). */
  platform?: "web" | "mobile";
  /** Required when platform is mobile. */
  mobile_os?: MobilePlatform;
  sheet_path?: string;
  column_mapping?: ColumnMapping;
  environment?: string;
  gap_cases?: NormalizedCase[];
  pdf_mode?: "base64" | "path" | "both";
  output_dir?: string;
  /** Prefer env/secret refs. Plaintext never logged or written into PDF text. */
  auth?: AuthInput;
  /** Alias for `auth` (HTTP API `login` field). */
  login?: AuthInput;
};

export type PipelineResult = {
  ok: boolean;
  error?: string;
  issues?: string[];
  run_id: string;
  summary?: ValidationSuiteResult["summary"];
  suite?: ValidationSuiteResult;
  pdf_path?: string;
  pdf_base64?: string;
  pdf_bytes?: number;
  catalog_count?: number;
  platform: string;
};

function mergeCatalog(
  excel: NormalizedCase[],
  gaps: NormalizedCase[],
): NormalizedCase[] {
  const normalize = (c: NormalizedCase, index: number, sourceDefault: NormalizedCase["source"]) => {
    const source = c.source ?? sourceDefault;
    const test_id =
      c.test_id?.trim() ||
      `tc_${source}_${String(index + 1).padStart(3, "0")}_${c.test_case_name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .slice(0, 32)}`;
    return { ...c, test_id, source, severity: c.severity ?? "medium" };
  };
  return [
    ...excel.map((c, i) => normalize(c, i, "excel")),
    ...gaps.map((c, i) => normalize({ ...c, source: c.source ?? "generated" }, i, "generated")),
  ];
}

function scoreSuite(
  app_name: string,
  platform: string,
  environment: string | undefined,
  catalog: NormalizedCase[],
  results: CaseResult[],
): ValidationSuiteResult {
  const byId = new Map(results.map((r) => [r.test_id, r]));
  const summary = { pass: 0, fail: 0, blocked: 0, not_run: 0, total: 0 };
  const cases = catalog.map((c) => {
    const r = byId.get(c.test_id);
    const status: CaseStatus = r?.status ?? "not_run";
    summary[status] += 1;
    summary.total += 1;
    return {
      ...c,
      status,
      evidence: r?.evidence,
      failure_analysis: r?.failure_analysis,
      blocked_reason: r?.blocked_reason ?? (r ? undefined : "No runner result for this case."),
      logs:
        r?.logs ??
        redactLogLines([`case=${c.test_id}`, "status=not_run", "reason=no_runner_result"]),
      screenshot: status === "fail" ? r?.screenshot : undefined,
      screenshot_blocked_reason:
        status === "fail"
          ? r?.screenshot_blocked_reason ??
            (r?.screenshot ? undefined : "No failure screenshot provided by runner.")
          : undefined,
    };
  });
  return {
    run_id: `run_${Date.now()}`,
    app_name,
    platform,
    timestamp_ist: nowIstIso(),
    environment,
    summary,
    cases,
    input_fingerprint: fingerprintPayload({ app_name, platform, catalog }),
  };
}

/** Deterministic validation pipeline for HTTP API and local scripts. */
export async function runValidationPipeline(input: PipelineInput): Promise<PipelineResult> {
  const briefCheck = validateBrief(input.brief);
  if (!briefCheck.ok) {
    return {
      ok: false,
      error: "Brief validation failed.",
      issues: briefCheck.issues,
      run_id: `run_${Date.now()}`,
      platform: input.platform ?? input.brief.app_type,
    };
  }
  const brief = briefCheck.brief;

  let excelCases: NormalizedCase[] = [];
  if (input.sheet_path) {
    try {
      const path = resolveSafePath(input.sheet_path, process.cwd());
      const { headers, rows } = loadTabularFile(path);
      const imported = rowsToCases(headers, rows, {
        mapping: input.column_mapping,
        source: "excel",
      });
      excelCases = imported.cases;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        run_id: `run_${Date.now()}`,
        platform: input.platform ?? brief.app_type,
      };
    }
  }

  const route: "web" | "mobile" =
    input.platform ??
    (brief.app_type === "mobile" ? "mobile" : brief.app_type === "hybrid" ? "web" : "web");

  const resolvedAuth = resolveAuth(input.auth ?? input.login);

  let gapCases = input.gap_cases ?? [];
  if (excelCases.length === 0 && gapCases.length === 0) {
    gapCases = generateExploreCases(brief, {
      platform: route,
      mobile_os: input.mobile_os,
      withAuth: Boolean(resolvedAuth),
      login_url: resolvedAuth?.login_url ?? input.login?.login_url ?? input.auth?.login_url,
    });
  }

  const catalog = mergeCatalog(excelCases, gapCases);
  if (catalog.length === 0) {
    return {
      ok: false,
      error:
        "No test cases. Provide sheet_path, or a web brief with base_url (auto-explore), or gap_cases.",
      run_id: `run_${Date.now()}`,
      platform: input.platform ?? brief.app_type,
    };
  }

  let results: CaseResult[] = [];
  let platformLabel: string = route;

  if (route === "web") {
    const base_url =
      brief.base_url ?? brief.environments?.find((e) => e.url)?.url;
    if (!base_url) {
      return {
        ok: false,
        error: "Web validation requires brief.base_url (or an environment url).",
        run_id: `run_${Date.now()}`,
        platform: "web",
      };
    }
    const web = runWebCases(base_url, catalog, { auth: resolvedAuth });
    results = web.results;
    platformLabel = `web:${web.fetch_via ?? "unknown"}`;
  } else {
    const mobile_os = input.mobile_os ?? brief.mobile?.platform;
    if (!mobile_os) {
      return {
        ok: false,
        error: "Mobile validation requires mobile_os (android|ios).",
        run_id: `run_${Date.now()}`,
        platform: "mobile",
      };
    }
    const mobile = runMobileCases(mobile_os, catalog, {
      package_or_bundle: brief.mobile?.package_or_bundle,
      emulator_id: brief.mobile?.emulator_id,
    });
    results = mobile.results;
    platformLabel = `mobile:${mobile_os}`;
  }

  const suite = scoreSuite(brief.app_name, platformLabel, input.environment, catalog, results);
  const pdfBytes = renderValidationPdf(suite);
  const outDir = input.output_dir ?? join(process.cwd(), "reports");
  mkdirSync(outDir, { recursive: true });
  const pdfPath = join(outDir, `${suite.run_id}.pdf`);
  writeFileSync(pdfPath, pdfBytes);
  writeFileSync(join(outDir, `${suite.run_id}.json`), JSON.stringify(suite, null, 2));

  const mode = input.pdf_mode ?? "both";
  return {
    ok: true,
    run_id: suite.run_id,
    summary: suite.summary,
    suite,
    catalog_count: catalog.length,
    platform: platformLabel,
    pdf_path: mode === "base64" ? undefined : pdfPath,
    pdf_base64: mode === "path" ? undefined : Buffer.from(pdfBytes).toString("base64"),
    pdf_bytes: pdfBytes.byteLength,
  };
}
