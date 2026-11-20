import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "./redact";

/** Prefer env / secret refs. Plaintext fields are accepted but never logged or written to PDF. */
export type AuthInput = {
  login_url?: string;
  username_env?: string;
  password_env?: string;
  username_secret_ref?: string;
  password_secret_ref?: string;
  username?: string;
  password?: string;
};

export type ResolvedAuth = {
  login_url?: string;
  username: string;
  password: string;
  source: "env" | "body";
};

const DEFAULT_USER_ENVS = ["MIZZOU_USER", "APP_VALIDATOR_USERNAME", "APP_UNDER_TEST_USER"];
const DEFAULT_PASS_ENVS = ["MIZZOU_PASSWORD", "APP_VALIDATOR_PASSWORD", "APP_UNDER_TEST_PASSWORD"];

function fromDefaultEnvs(login_url?: string): ResolvedAuth | null {
  for (let i = 0; i < DEFAULT_USER_ENVS.length; i++) {
    const userKey = DEFAULT_USER_ENVS[i]!;
    const passKey = DEFAULT_PASS_ENVS[i]!;
    const username = process.env[userKey];
    const password = process.env[passKey];
    if (username && password) {
      return { login_url, username, password, source: "env" };
    }
  }
  return null;
}

export function resolveAuth(input?: AuthInput | null): ResolvedAuth | null {
  if (!input) {
    return fromDefaultEnvs();
  }
  const userKey = input.username_env || input.username_secret_ref;
  const passKey = input.password_env || input.password_secret_ref;
  const username = (userKey ? process.env[userKey] : undefined) || input.username;
  const password = (passKey ? process.env[passKey] : undefined) || input.password;
  if (username && password) {
    return {
      login_url: input.login_url,
      username,
      password,
      source: userKey || passKey ? "env" : "body",
    };
  }
  // Partial login object still allows default env pair fallback.
  return fromDefaultEnvs(input.login_url);
}

type FormFields = {
  action: string;
  method: string;
  fields: Record<string, string>;
  userField: string;
  passField: string;
};

function absolutize(base: string, action: string): string {
  try {
    return new URL(action || ".", base).toString();
  } catch {
    return base;
  }
}

function parseLoginForm(html: string, pageUrl: string): FormFields | null {
  const formMatch =
    /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  let best: FormFields | null = null;
  let m: RegExpExecArray | null;
  while ((m = formMatch.exec(html))) {
    const formTag = m[0].slice(0, m[0].indexOf(">") + 1);
    const body = m[1] ?? "";
    if (!/type=["']password["']/i.test(body)) continue;
    const action = /action=["']([^"']*)["']/i.exec(formTag)?.[1] ?? "";
    const method = (/method=["']([^"']*)["']/i.exec(formTag)?.[1] ?? "post").toLowerCase();
    const fields: Record<string, string> = {};
    const inputRe = /<input\b[^>]*>/gi;
    let im: RegExpExecArray | null;
    let userField = "";
    let passField = "";
    while ((im = inputRe.exec(body))) {
      const tag = im[0];
      const name = /name=["']([^"']+)["']/i.exec(tag)?.[1];
      if (!name) continue;
      const type = (/type=["']([^"']+)["']/i.exec(tag)?.[1] ?? "text").toLowerCase();
      const value = /value=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
      if (type === "submit" || type === "button" || type === "image") continue;
      if (type === "password") {
        passField = name;
        fields[name] = "";
        continue;
      }
      fields[name] = value;
      if (
        !userField &&
        (type === "email" ||
          type === "text" ||
          type === "tel" ||
          /user|email|login|account|phone/i.test(name))
      ) {
        userField = name;
      }
    }
    if (!passField) continue;
    if (!userField) {
      const candidate = Object.keys(fields).find((k) => k !== passField);
      if (candidate) userField = candidate;
    }
    if (!userField) continue;
    best = {
      action: absolutize(pageUrl, action),
      method: method === "get" ? "get" : "post",
      fields,
      userField,
      passField,
    };
    break;
  }
  return best;
}

export type LoginAttemptResult = {
  ok: boolean;
  detail: string;
  httpCode?: number;
  cookieHeader?: string;
  finalUrl?: string;
  htmlExcerpt: string;
  log: string[];
};

function curlWithCookies(
  url: string,
  opts: {
    method?: string;
    body?: string;
    cookieJar: string;
    referer?: string;
  },
): { status: number; stdout: string; stderr: string; httpCode?: number } {
  const args = [
    "-sSL",
    "--max-time",
    "20",
    "-A",
    "app-validator-login-explore/1.0",
    "-c",
    opts.cookieJar,
    "-b",
    opts.cookieJar,
    "-w",
    "\nHTTP_CODE:%{http_code}",
  ];
  if (opts.referer) args.push("-e", opts.referer);
  if (opts.method === "post") {
    args.push("-X", "POST", "-H", "content-type: application/x-www-form-urlencoded", "--data", opts.body ?? "");
  }
  args.push(url);
  const r = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 5_000_000 });
  const raw = r.stdout ?? "";
  const codeMatch = /HTTP_CODE:(\d+)\s*$/.exec(raw);
  const body = codeMatch ? raw.slice(0, codeMatch.index) : raw;
  return {
    status: r.status ?? 1,
    stdout: body,
    stderr: r.stderr ?? "",
    httpCode: codeMatch ? Number(codeMatch[1]) : undefined,
  };
}

function looksLoggedIn(html: string): boolean {
  return (
    /logout|sign\s*out|log\s*out/i.test(html) ||
    (/dashboard|my\s*account|profile|welcome/i.test(html) &&
      !/type=["']password["']/i.test(html))
  );
}

function looksLoginRejected(html: string, httpCode?: number): boolean {
  if (httpCode === 401 || httpCode === 403) return true;
  return /invalid|incorrect|failed|wrong\s+password|authentication|unauthorized|try\s+again/i.test(
    html,
  );
}

/** Best-effort form login via curl cookie jar. Never returns password/username in log/detail. */
export function attemptFormLogin(
  baseUrl: string,
  auth: ResolvedAuth,
  mode: "valid" | "invalid",
): LoginAttemptResult {
  const dir = mkdtempSync(join(tmpdir(), "av-auth-"));
  const jar = join(dir, "cookies.txt");
  writeFileSync(jar, "");
  const log: string[] = [];
  try {
    const loginUrl = auth.login_url || baseUrl;
    log.push(`login_get=${loginUrl}`, `auth_source=${auth.source}`);
    const get = curlWithCookies(loginUrl, { cookieJar: jar });
    log.push(`login_get_http=${get.httpCode ?? "unknown"}`, `login_get_exit=${get.status}`);
    if (get.status !== 0 && !(get.httpCode && get.httpCode >= 100)) {
      return {
        ok: false,
        detail: "Could not load login page.",
        httpCode: get.httpCode,
        htmlExcerpt: "",
        log: redactSecrets(log.join("\n")).split("\n"),
      };
    }
    const form = parseLoginForm(get.stdout, loginUrl);
    if (!form) {
      return {
        ok: false,
        detail:
          "No HTML login form with username/password fields found (SPA/API login may need a dedicated automation stack).",
        httpCode: get.httpCode,
        htmlExcerpt: get.stdout.replace(/\s+/g, " ").slice(0, 200),
        log: redactSecrets([...log, "form=missing"].join("\n")).split("\n"),
      };
    }
    log.push(`form_action=${form.action}`, `form_method=${form.method}`, `user_field=${form.userField}`);
    const password = mode === "valid" ? auth.password : `invalid-${Date.now()}`;
    const payload = { ...form.fields, [form.userField]: auth.username, [form.passField]: password };
    const body = Object.entries(payload)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const post = curlWithCookies(form.action, {
      method: form.method,
      body,
      cookieJar: jar,
      referer: loginUrl,
    });
    log.push(`login_post_http=${post.httpCode ?? "unknown"}`, `login_post_exit=${post.status}`);
    const html = post.stdout;
    const excerpt = html.replace(/\s+/g, " ").slice(0, 240);
    let cookieHeader: string | undefined;
    try {
      const jarText = readFileSync(jar, "utf8");
      const parts = jarText
        .split("\n")
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => {
          const cols = l.split("\t");
          return cols.length >= 7 ? `${cols[5]}=${cols[6]}` : "";
        })
        .filter(Boolean);
      if (parts.length) cookieHeader = parts.join("; ");
    } catch {
      /* ignore */
    }

    if (mode === "invalid") {
      const rejected =
        looksLoginRejected(html, post.httpCode) ||
        /type=["']password["']/i.test(html) ||
        !looksLoggedIn(html);
      return {
        ok: rejected,
        detail: rejected
          ? "Invalid credentials were rejected or login form remained (expected)."
          : "Invalid credentials appeared to succeed — check auth hardening.",
        httpCode: post.httpCode,
        cookieHeader,
        htmlExcerpt: excerpt,
        log: redactSecrets(log.join("\n")).split("\n"),
      };
    }

    const success =
      looksLoggedIn(html) ||
      (Boolean(cookieHeader) && !/type=["']password["']/i.test(html) && (post.httpCode ?? 200) < 400);
    return {
      ok: success,
      detail: success
        ? "Login form accepted credentials (session cookie or post-login page signals)."
        : "Login POST completed but session/login-success signals were not detected.",
      httpCode: post.httpCode,
      cookieHeader,
      finalUrl: form.action,
      htmlExcerpt: excerpt,
      log: redactSecrets(log.join("\n")).split("\n"),
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function fetchWithCookie(
  url: string,
  cookieHeader?: string,
): { ok: boolean; html: string; httpCode?: number; log: string[] } {
  const args = [
    "-sSL",
    "--max-time",
    "15",
    "-A",
    "app-validator-login-explore/1.0",
    "-w",
    "\nHTTP_CODE:%{http_code}",
  ];
  if (cookieHeader) args.push("-H", `Cookie: ${cookieHeader}`);
  args.push(url);
  const r = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 5_000_000 });
  const raw = r.stdout ?? "";
  const codeMatch = /HTTP_CODE:(\d+)\s*$/.exec(raw);
  const html = codeMatch ? raw.slice(0, codeMatch.index) : raw;
  return {
    ok: (r.status ?? 1) === 0,
    html,
    httpCode: codeMatch ? Number(codeMatch[1]) : undefined,
    log: redactSecrets(
      [`curl_auth ${url}`, `exit=${r.status}`, `http_code=${codeMatch?.[1] ?? "unknown"}`].join("\n"),
    ).split("\n"),
  };
}
