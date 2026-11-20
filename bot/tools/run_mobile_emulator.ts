import { spawnSync } from "node:child_process";
import { prompt } from "@grok/agent-sdk";
import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { redactLogLines } from "../lib/redact";
import { captureAndroidScreenshot, captureIosScreenshot } from "../lib/screenshots";
import type { CaseResult, FailureScreenshot } from "../lib/types";

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

function run(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000 });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function probeAndroid(emulator_id?: string): {
  available: boolean;
  devices: string[];
  detail: string;
  log: string[];
} {
  const which = run("which", ["adb"]);
  if (!which.ok) {
    return {
      available: false,
      devices: [],
      detail: "adb not found. Wire this tool on a local/self-hosted worker with Android SDK.",
      log: ["adb=missing"],
    };
  }
  const devices = run("adb", ["devices"]);
  const lines = devices.stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("*"));
  const ids = lines
    .map((l) => l.split(/\s+/)[0]!)
    .filter((id) => id && id !== "List");
  const online = lines.filter((l) => /\tdevice\b/.test(l)).map((l) => l.split(/\s+/)[0]!);
  const log = [
    "adb=present",
    `devices_raw=${devices.stdout.replace(/\s+/g, " ").slice(0, 200)}`,
    `online=${online.join(",") || "(none)"}`,
  ];
  if (emulator_id && !online.includes(emulator_id)) {
    return {
      available: false,
      devices: ids,
      detail: `Requested emulator_id ${emulator_id} not online. Seen: ${ids.join(", ") || "(none)"}`,
      log: [...log, `requested=${emulator_id}`, "status=offline"],
    };
  }
  return {
    available: online.length > 0,
    devices: online,
    detail:
      online.length > 0
        ? `Android devices online: ${online.join(", ")}`
        : "No Android emulator device online.",
    log,
  };
}

function probeIos(emulator_id?: string): {
  available: boolean;
  devices: string[];
  detail: string;
  log: string[];
} {
  const which = run("which", ["xcrun"]);
  if (!which.ok) {
    return {
      available: false,
      devices: [],
      detail: "xcrun not found. iOS simulation requires macOS with Xcode on a local worker.",
      log: ["xcrun=missing"],
    };
  }
  const list = run("xcrun", ["simctl", "list", "devices", "booted"]);
  const booted = [...list.stdout.matchAll(/\(([-A-F0-9]+)\)\s+\(Booted\)/gi)].map((m) => m[1]!);
  const log = [
    "xcrun=present",
    `booted=${booted.join(",") || "(none)"}`,
    `stdout=${list.stdout.replace(/\s+/g, " ").slice(0, 200)}`,
  ];
  if (emulator_id && !booted.includes(emulator_id) && !list.stdout.includes(emulator_id)) {
    return {
      available: false,
      devices: booted,
      detail: `Requested iOS simulator ${emulator_id} not booted.`,
      log: [...log, `requested=${emulator_id}`, "status=not_booted"],
    };
  }
  return {
    available: booted.length > 0 || /Booted/.test(list.stdout),
    devices: booted,
    detail:
      booted.length > 0
        ? `Booted iOS simulators: ${booted.join(", ")}`
        : list.stdout.trim() || "No booted iOS simulator.",
    log,
  };
}

function attachFailScreenshot(
  result: CaseResult,
  platform: "android" | "ios",
  emulator_id?: string,
): CaseResult {
  if (result.status !== "fail") return result;
  const shot =
    platform === "android"
      ? captureAndroidScreenshot(emulator_id)
      : captureIosScreenshot(emulator_id);
  if (shot.ok) {
    const screenshot: FailureScreenshot = {
      mime: shot.mime,
      base64: shot.base64,
      source: shot.source,
      bytes: shot.bytes,
    };
    return {
      ...result,
      screenshot,
      logs: redactLogLines([
        ...(result.logs ?? []),
        `screenshot=ok source=${shot.source} bytes=${shot.bytes}`,
      ]),
    };
  }
  return {
    ...result,
    screenshot_blocked_reason: shot.blocked_reason,
    logs: redactLogLines([
      ...(result.logs ?? []),
      `screenshot=blocked reason=${shot.blocked_reason}`,
    ]),
  };
}

export default defineTool({
  description: prompt`
    Drive mobile validation against a local emulator.
    platform is required at run time: android or ios (ask the user; never hard-code).
    Collects redacted per-case logs. On Fail, captures emulator screenshot via adb/simctl
    when available; otherwise records screenshot_blocked_reason.
    On cloud VMs without an emulator, returns blocked results — does not require a live emulator.
  `,
  effect: "idempotent",
  inputSchema: z.object({
    platform: z.enum(["android", "ios"]),
    package_or_bundle: z.string().optional(),
    emulator_id: z.string().optional(),
    cases: z.array(CaseSchema),
    require_live_emulator: z
      .boolean()
      .optional()
      .describe("Default false. When true, fail closed if emulator probe finds nothing."),
  }),
  async execute({
    platform,
    package_or_bundle,
    emulator_id,
    cases,
    require_live_emulator,
  }) {
    const probe = platform === "android" ? probeAndroid(emulator_id) : probeIos(emulator_id);
    const requireLive = require_live_emulator === true;

    if (!probe.available) {
      const blocked_reason = requireLive
        ? probe.detail
        : `${probe.detail} Mobile execution is stubbed for this host; run on the self-hosted worker that hosts the emulator.`;
      return {
        ok: !requireLive,
        platform,
        emulator_available: false,
        devices: probe.devices,
        detail: probe.detail,
        package_or_bundle: package_or_bundle ?? null,
        automation_stack: "unspecified — confirm Appium/Maestro/other before deep UI drive",
        results: cases.map(
          (c): CaseResult => ({
            test_id: c.test_id,
            status: "blocked",
            blocked_reason,
            logs: redactLogLines([
              ...probe.log,
              `platform=${platform}`,
              `case=${c.test_id}`,
              `status=blocked`,
            ]),
          }),
        ),
      };
    }

    const results: CaseResult[] = cases.map((c) => {
      const baseLogs = redactLogLines([
        ...probe.log,
        `platform=${platform}`,
        `case=${c.test_id}`,
        `name=${c.test_case_name}`,
        `steps=${c.steps.join(" | ")}`,
        `package=${package_or_bundle ?? ""}`,
      ]);

      if (c.app_type === "web") {
        return {
          test_id: c.test_id,
          status: "not_run" as const,
          blocked_reason: "Case targets web; use run_web_chrome.",
          logs: [...baseLogs, "status=not_run", "routed=web"],
        };
      }
      const interactive = c.steps.some((s) =>
        /(tap|click|type|enter|swipe|launch|open app)/i.test(s),
      );
      if (interactive) {
        return {
          test_id: c.test_id,
          status: "blocked" as const,
          evidence: [`Emulator probe ok: ${probe.detail}`],
          blocked_reason:
            "Emulator reachable, but no automation stack is configured yet (Appium/Maestro/etc). Do not invent selectors.",
          logs: [...baseLogs, "status=blocked", "reason=no_automation_stack"],
        };
      }

      // Probe-only cases currently Pass. If expected_result is set and clearly
      // cannot be verified without UI automation, mark Fail and capture screenshot.
      const expected = (c.expected_result ?? "").trim();
      if (expected && !/probe|online|device|booted/i.test(expected)) {
        return attachFailScreenshot(
          {
            test_id: c.test_id,
            status: "fail",
            evidence: [`Emulator probe ok: ${probe.detail}`],
            failure_analysis: `Expected UI result "${expected}" could not be verified without an automation stack.`,
            logs: [...baseLogs, "status=fail", "reason=expected_without_automation"],
          },
          platform,
          emulator_id,
        );
      }

      return {
        test_id: c.test_id,
        status: "pass" as const,
        evidence: [`Emulator probe ok: ${probe.detail}`, "Non-interactive / probe-only case."],
        logs: [...baseLogs, "status=pass", "assert=probe_only"],
      };
    });

    return {
      ok: true as const,
      platform,
      emulator_available: true,
      devices: probe.devices,
      detail: probe.detail,
      package_or_bundle: package_or_bundle ?? null,
      results,
    };
  },
});
