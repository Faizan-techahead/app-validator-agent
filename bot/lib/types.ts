/** Shared validation types. Prefer type aliases (JSON-shaped tool returns). */

export type AppType = "web" | "mobile" | "hybrid" | "api" | "docs_only";
export type MobilePlatform = "android" | "ios";
export type CaseSeverity = "critical" | "high" | "medium" | "low";
export type CaseSource = "excel" | "generated" | "brief";
export type CaseStatus = "pass" | "fail" | "blocked" | "not_run";

export type ApplicationBrief = {
  app_name: string;
  app_type: AppType;
  base_url?: string;
  mobile?: {
    platform?: MobilePlatform;
    package_or_bundle?: string;
    emulator_id?: string;
  };
  environments?: Array<{
    name: string;
    url?: string;
  }>;
  roles?: string[];
  critical_flows?: string[];
  auth_secret_refs?: string[];
  constraints?: string[];
  in_scope?: string[];
  out_of_scope?: string[];
};

export type NormalizedCase = {
  test_id: string;
  test_case_name: string;
  steps: string[];
  expected_result?: string;
  preconditions?: string;
  severity: CaseSeverity;
  app_type?: AppType;
  source: CaseSource;
};

export type FailureScreenshot = {
  mime: "image/png" | "image/jpeg";
  base64: string;
  source?: string;
  bytes?: number;
};

export type CaseResult = {
  test_id: string;
  status: CaseStatus;
  evidence?: string[];
  failure_analysis?: string;
  blocked_reason?: string;
  /** Redacted per-case execution logs (always captured when the runner ran). */
  logs?: string[];
  /** Failure-only screenshot, when capture succeeded. */
  screenshot?: FailureScreenshot;
  /** Set when status=fail but screenshot could not be captured. */
  screenshot_blocked_reason?: string;
};

export type ValidationSuiteResult = {
  run_id: string;
  app_name: string;
  platform: string;
  timestamp_ist: string;
  environment?: string;
  summary: {
    pass: number;
    fail: number;
    blocked: number;
    not_run: number;
    total: number;
  };
  cases: Array<NormalizedCase & CaseResult>;
  input_fingerprint: string;
};

export type ColumnMapping = {
  test_case_name?: string;
  steps?: string;
  expected_result?: string;
  preconditions?: string;
  severity?: string;
  app_type?: string;
  test_id?: string;
};
