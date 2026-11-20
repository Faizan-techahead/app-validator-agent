import { isAbsolute, join, normalize, resolve } from "node:path";
import { existsSync } from "node:fs";

/** Resolve a user/workspace path without escaping the workspace when relative. */
export function resolveSafePath(path: string, workspaceDir?: string): string {
  if (isAbsolute(path)) return normalize(path);
  const base = workspaceDir ?? process.cwd();
  return normalize(join(base, path));
}

export function findExistingPath(candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

export function projectFixture(...parts: string[]): string {
  return resolve(process.cwd(), "evals", "fixtures", ...parts);
}
