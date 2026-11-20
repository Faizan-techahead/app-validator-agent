import { redactSecrets } from "./redact";
import type { LoginAttemptResult, ResolvedAuth } from "./auth";
import { cdpEvaluate, findChromeBinary, launchChromeCdp } from "./chrome";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function looksLoggedIn(html: string): boolean {
  return (
    /logout|sign\s*out|log\s*out/i.test(html) ||
    (/dashboard|my\s*account|profile|welcome/i.test(html) &&
      !/type=["']password["']/i.test(html))
  );
}

/**
 * Chrome CDP SPA login: wait for password field, fill via React-friendly setters, submit.
 * Never puts username/password into logs or returned detail text.
 */
export async function attemptSpaLogin(
  baseUrl: string,
  auth: ResolvedAuth,
  mode: "valid" | "invalid",
): Promise<LoginAttemptResult & { via: "chrome-spa" | "unavailable" }> {
  const chrome = findChromeBinary();
  const log: string[] = [
    `spa_login=start`,
    `auth_source=${auth.source}`,
    `headed=${process.env.APP_VALIDATOR_HEADED ?? "0"}`,
  ];
  if (!chrome) {
    return {
      ok: false,
      via: "unavailable",
      detail: "Chrome binary not found for SPA login.",
      htmlExcerpt: "",
      log: redactSecrets(log.concat(["chrome=missing"]).join("\n")).split("\n"),
    };
  }

  let client: Awaited<ReturnType<typeof launchChromeCdp>> | undefined;
  try {
    client = await launchChromeCdp(chrome);
    log.push(
      `chrome=${chrome}`,
      `cdp_port=${client.port}`,
      `user_data_dir=${client.profileDir}`,
    );
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Network.enable");

    const loginUrl = auth.login_url || baseUrl;
    log.push(`navigate=${loginUrl}`);
    await client.send("Page.navigate", { url: loginUrl });
    await sleep(2500);

    // Wait up to ~12s for a password field (SPA hydrate).
    let ready = false;
    for (let i = 0; i < 24; i++) {
      const probe = await cdpEvaluate(
        client,
        `!!document.querySelector('input[type="password"]')`,
      );
      if (probe.value === true) {
        ready = true;
        break;
      }
      await sleep(500);
    }
    if (!ready) {
      const htmlProbe = await cdpEvaluate(client, `document.documentElement?.outerHTML?.slice(0,5000) || ''`);
      const html = String(htmlProbe.value ?? "");
      return {
        ok: false,
        via: "chrome-spa",
        detail:
          "SPA login: no password input appeared after wait (page may use a non-standard auth UI).",
        htmlExcerpt: html.replace(/\s+/g, " ").slice(0, 240),
        log: redactSecrets(log.concat(["password_input=missing"]).join("\n")).split("\n"),
      };
    }
    log.push("password_input=ready");

    const password = mode === "valid" ? auth.password : `invalid-${Date.now()}`;
    // Credentials only inside the evaluate payload — never appended to log.
    const fillExpr = `(() => {
      const userVal = ${JSON.stringify(auth.username)};
      const passVal = ${JSON.stringify(password)};
      const setNative = (el, v) => {
        const proto = window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, v);
        else el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const pass = document.querySelector('input[type="password"]');
      if (!pass) return { ok: false, reason: 'no_password' };
      const root = pass.closest('form') || document.body;
      const candidates = Array.from(root.querySelectorAll('input')).filter((el) => {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        return t === 'text' || t === 'email' || t === 'tel' || t === 'username' || !el.getAttribute('type');
      });
      let user = candidates.find((el) => /user|email|login|account|phone/i.test(el.name || el.id || el.autocomplete || ''))
        || candidates[0];
      if (!user) return { ok: false, reason: 'no_user' };
      setNative(user, userVal);
      setNative(pass, passVal);
      const btn = root.querySelector('button[type="submit"],input[type="submit"],button');
      if (btn) btn.click();
      else if (root.requestSubmit) root.requestSubmit();
      else if (typeof root.submit === 'function') root.submit();
      return { ok: true, userField: user.name || user.id || 'user' };
    })()`;

    const filled = await cdpEvaluate(client, fillExpr);
    if (filled.exception) {
      return {
        ok: false,
        via: "chrome-spa",
        detail: "SPA login script failed to run in page.",
        htmlExcerpt: "",
        log: redactSecrets(log.concat([`evaluate_error=${filled.exception}`]).join("\n")).split("\n"),
      };
    }
    const fillVal = filled.value as { ok?: boolean; reason?: string; userField?: string } | undefined;
    if (!fillVal?.ok) {
      return {
        ok: false,
        via: "chrome-spa",
        detail: `SPA login could not fill fields (${fillVal?.reason ?? "unknown"}).`,
        htmlExcerpt: "",
        log: redactSecrets(log.concat([`fill=${fillVal?.reason ?? "fail"}`]).join("\n")).split("\n"),
      };
    }
    log.push(`filled_user_field=${fillVal.userField ?? "user"}`);
    await sleep(3500);

    const htmlRes = await cdpEvaluate(
      client,
      `document.documentElement?.outerHTML?.slice(0, 120000) || ''`,
    );
    const html = String(htmlRes.value ?? "");
    // Keep enough DOM for auth-session evidence checks (no secrets in markup expected).
    const excerpt = html.replace(/\s+/g, " ").slice(0, 4000);
    const urlRes = await cdpEvaluate(client, `location.href`);
    const finalUrl = String(urlRes.value ?? loginUrl);
    log.push(`final_url=${finalUrl}`);

    const cookieRes = await cdpEvaluate(client, `document.cookie || ''`);
    const cookieHeader = String(cookieRes.value ?? "") || undefined;

    if (mode === "invalid") {
      const rejected =
        /invalid|incorrect|failed|wrong\s+password|unauthorized|try\s+again/i.test(html) ||
        /type=["']password["']/i.test(html) ||
        !looksLoggedIn(html);
      return {
        ok: rejected,
        via: "chrome-spa",
        detail: rejected
          ? "SPA invalid-login: credentials rejected or login UI remained (expected)."
          : "SPA invalid-login: session looked authenticated — check auth hardening.",
        cookieHeader,
        finalUrl,
        htmlExcerpt: excerpt,
        log: redactSecrets(log.join("\n")).split("\n"),
      };
    }

    const success =
      looksLoggedIn(html) ||
      (!/type=["']password["']/i.test(html) &&
        Boolean(cookieHeader) &&
        /dashboard|account|profile|welcome|home|mizzou/i.test(html));
    return {
      ok: success,
      via: "chrome-spa",
      detail: success
        ? "SPA Chrome login produced authenticated DOM/cookie signals."
        : "SPA Chrome login completed but authenticated DOM signals were not detected.",
      cookieHeader,
      finalUrl,
      htmlExcerpt: excerpt,
      log: redactSecrets(log.join("\n")).split("\n"),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stderr = client?.stderrTail?.() ?? "";
    return {
      ok: false,
      via: "chrome-spa",
      detail: `SPA Chrome login failed: ${msg}`,
      htmlExcerpt: "",
      log: redactSecrets(
        log
          .concat([
            `spa_error=1`,
            `error=${msg}`,
            stderr ? `chrome_stderr=${stderr}` : "chrome_stderr=(empty)",
          ])
          .join("\n"),
      ).split("\n"),
    };
  } finally {
    try {
      client?.close();
    } catch {
      /* ignore */
    }
  }
}
