import type { ApplicationBrief, MobilePlatform, NormalizedCase } from "./types";

const MISSING_PATH = "/__app_validator_no_such_route__";

function resolveBaseUrl(brief: ApplicationBrief): string | undefined {
  return brief.base_url ?? brief.environments?.find((e) => e.url)?.url;
}

/**
 * Generic URL-based exploratory cases when no Excel sheet is provided.
 * Does not invent private product rules — only home load, document chrome,
 * and an invalid-path negative check against the given base URL.
 */
export function generateExploreCases(
  brief: ApplicationBrief,
  opts?: {
    platform?: "web" | "mobile";
    mobile_os?: MobilePlatform;
    /** When credentials resolve, add login / negative / session / logout explores. */
    withAuth?: boolean;
    login_url?: string;
  },
): NormalizedCase[] {
  const platform =
    opts?.platform ??
    (brief.app_type === "mobile" ? "mobile" : "web");

  if (platform === "mobile") {
    const os = opts?.mobile_os ?? brief.mobile?.platform ?? "android";
    return [
      {
        test_id: "tc_explore_emulator_probe",
        test_case_name: `Emulator probe (${os})`,
        steps: ["Probe local emulator online status"],
        expected_result: "device online or booted",
        severity: "critical",
        app_type: "mobile",
        source: "generated",
      },
    ];
  }

  const base = resolveBaseUrl(brief);
  if (!base) return [];

  let origin: string;
  let home: string;
  try {
    const u = new URL(base);
    origin = u.origin;
    home = base.endsWith("/") ? base : `${base}/`;
  } catch {
    return [];
  }
  const missingUrl = `${origin}${MISSING_PATH}`;
  const loginTarget = opts?.login_url || home;

  const cases: NormalizedCase[] = [
    {
      test_id: "tc_explore_home_loads",
      test_case_name: "Home page loads",
      steps: [`Open ${home}`, "Verify rendered login screen or app shell"],
      expected_result: "ASSERT:APP_SHELL",
      severity: "critical",
      app_type: "web",
      source: "generated",
    },
    {
      test_id: "tc_explore_document_title",
      test_case_name: "Document title is present",
      steps: [`Open ${home}`, "Verify the document has a non-empty title"],
      expected_result: "ASSERT:TITLE",
      severity: "high",
      app_type: "web",
      source: "generated",
    },
    {
      test_id: "tc_explore_heading_or_main",
      test_case_name: "Primary heading, main landmark, or substantial body content",
      steps: [`Open ${home}`, "Verify an h1/h2, main landmark, or substantial body content exists"],
      expected_result: "ASSERT:HEADING_OR_MAIN",
      severity: "high",
      app_type: "web",
      source: "generated",
    },
    {
      test_id: "tc_explore_nav_or_links",
      test_case_name: "Navigation, links, or interactive controls present",
      steps: [`Open ${home}`, "Verify nav, links, or buttons exist"],
      expected_result: "ASSERT:NAV_OR_LINKS",
      severity: "medium",
      app_type: "web",
      source: "generated",
    },
    {
      test_id: "tc_explore_invalid_path",
      test_case_name: "Unknown path returns error or not-found response",
      steps: [`Open ${missingUrl}`, "Verify the response is not a successful home page"],
      expected_result: "ASSERT:NOT_FOUND_OR_ERROR",
      severity: "medium",
      app_type: "web",
      source: "generated",
    },
  ];

  if (opts?.withAuth) {
    cases.push(
      {
        test_id: "tc_explore_login_valid",
        test_case_name: "Login with provided credentials",
        steps: [`Open ${loginTarget}`, "Submit username/password from env or secret refs"],
        expected_result: "ASSERT:LOGIN_VALID",
        severity: "critical",
        app_type: "web",
        source: "generated",
      },
      {
        test_id: "tc_explore_login_invalid",
        test_case_name: "Login rejected with invalid password",
        steps: [`Open ${loginTarget}`, "Submit username with an intentionally wrong password"],
        expected_result: "ASSERT:LOGIN_INVALID",
        severity: "high",
        app_type: "web",
        source: "generated",
      },
      {
        test_id: "tc_explore_post_login_session",
        test_case_name: "Authenticated session can load home",
        steps: [`Open ${home}`, "Verify authenticated session cookie loads home"],
        expected_result: "ASSERT:AUTH_SESSION",
        severity: "high",
        app_type: "web",
        source: "generated",
      },
      {
        test_id: "tc_explore_logout_affordance",
        test_case_name: "Logout or sign-out affordance visible when logged in",
        steps: [`Open ${home}`, "Verify logout/sign-out control after login"],
        expected_result: "ASSERT:LOGOUT_AFFORDANCE",
        severity: "medium",
        app_type: "web",
        source: "generated",
      },
    );
  }

  return cases;
}
