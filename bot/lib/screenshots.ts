import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeProcessArgs } from "./chrome";

export type ScreenshotCapture = {
  ok: true;
  mime: "image/png" | "image/jpeg";
  base64: string;
  bytes: number;
  source: "chrome" | "adb" | "simctl";
} | {
  ok: false;
  blocked_reason: string;
};

function toCapture(
  filePath: string,
  source: "chrome" | "adb" | "simctl",
): ScreenshotCapture {
  const buf = readFileSync(filePath);
  if (buf.byteLength < 32) {
    return { ok: false, blocked_reason: `${source} wrote an empty or tiny screenshot.` };
  }
  const mime =
    buf[0] === 0xff && buf[1] === 0xd8
      ? ("image/jpeg" as const)
      : ("image/png" as const);
  return {
    ok: true,
    mime,
    base64: buf.toString("base64"),
    bytes: buf.byteLength,
    source,
  };
}

export function captureChromeScreenshot(
  chrome: string,
  url: string,
): ScreenshotCapture {
  const dir = mkdtempSync(join(tmpdir(), "app-validator-shot-"));
  const out = join(dir, "fail.png");
  try {
    // Screenshots always use headless CLI (headed is for interactive CDP only).
    const result = spawnSync(
      chrome,
      chromeProcessArgs(
        ["--window-size=1280,720", "--virtual-time-budget=5000", `--screenshot=${out}`, url],
        "headless",
      ),
      { encoding: "utf8", timeout: 20_000 },
    );
    if (result.error) {
      return {
        ok: false,
        blocked_reason: `Chrome screenshot failed: ${result.error.message}`,
      };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        blocked_reason: `Chrome screenshot exited ${result.status}: ${(result.stderr || "").slice(0, 200)}`,
      };
    }
    try {
      return toCapture(out, "chrome");
    } catch {
      return {
        ok: false,
        blocked_reason: "Chrome screenshot completed but output file was missing.",
      };
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

export function captureAndroidScreenshot(
  emulator_id?: string,
): ScreenshotCapture {
  const which = spawnSync("which", ["adb"], { encoding: "utf8" });
  if (which.status !== 0) {
    return { ok: false, blocked_reason: "adb not available for failure screenshot." };
  }
  const dir = mkdtempSync(join(tmpdir(), "app-validator-adb-"));
  const out = join(dir, "fail.png");
  try {
    const args = emulator_id
      ? ["-s", emulator_id, "exec-out", "screencap", "-p"]
      : ["exec-out", "screencap", "-p"];
    const result = spawnSync("adb", args, {
      encoding: "buffer",
      maxBuffer: 20_000_000,
      timeout: 15_000,
    });
    if (result.error) {
      return { ok: false, blocked_reason: `adb screencap failed: ${result.error.message}` };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        blocked_reason: `adb screencap exited ${result.status}`,
      };
    }
    const stdout = result.stdout as Buffer;
    if (!stdout || stdout.byteLength < 32) {
      return { ok: false, blocked_reason: "adb screencap returned empty output." };
    }
    writeFileSync(out, stdout);
    return toCapture(out, "adb");
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function captureIosScreenshot(emulator_id?: string): ScreenshotCapture {
  const which = spawnSync("which", ["xcrun"], { encoding: "utf8" });
  if (which.status !== 0) {
    return { ok: false, blocked_reason: "xcrun not available for failure screenshot." };
  }
  const dir = mkdtempSync(join(tmpdir(), "app-validator-ios-"));
  const out = join(dir, "fail.png");
  try {
    const target = emulator_id && emulator_id.length > 0 ? emulator_id : "booted";
    const result = spawnSync(
      "xcrun",
      ["simctl", "io", target, "screenshot", out],
      { encoding: "utf8", timeout: 15_000 },
    );
    if (result.error) {
      return { ok: false, blocked_reason: `simctl screenshot failed: ${result.error.message}` };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        blocked_reason: `simctl screenshot exited ${result.status}: ${(result.stderr || "").slice(0, 200)}`,
      };
    }
    try {
      return toCapture(out, "simctl");
    } catch {
      return {
        ok: false,
        blocked_reason: "simctl screenshot completed but output file was missing.",
      };
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
