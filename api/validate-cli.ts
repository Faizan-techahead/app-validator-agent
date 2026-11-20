#!/usr/bin/env npx tsx
/**
 * Simple CLI: URL + optional credentials → explore → headed Chrome → PDF.
 * Never prints password values.
 *
 *   npm run validate -- --url https://example.com --username u --password '…'
 */
import { runSimpleValidate } from "../bot/lib/simple-validate";

function usage(): never {
  console.error(`Usage:
  npm run validate -- --url <https://…> [--username <user>] [--password <pass>] [--app-name <name>]

Chrome: auto-detects /Applications/Google Chrome.app (or CHROME_PATH).
Headed: on by default (APP_VALIDATOR_HEADED=0 to disable).`);
  process.exit(2);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
  const url = arg("--url");
  if (!url) usage();
  const username = arg("--username") ?? arg("--user");
  const password = arg("--password") ?? arg("--pass");
  const app_name = arg("--app-name") ?? arg("--name");

  if (!process.env.APP_VALIDATOR_HEADED) process.env.APP_VALIDATOR_HEADED = "1";

  const result = await runSimpleValidate({
    url: url!,
    username,
    password,
    app_name,
    pdf_mode: "path",
  });

  if (!result.ok) {
    console.error(JSON.stringify({ ok: false, error: result.error, issues: result.issues }, null, 2));
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        run_id: result.run_id,
        platform: result.platform,
        summary: result.summary,
        catalog_count: result.catalog_count,
        pdf_path: result.pdf_path,
        cases: result.suite?.cases.map((c) => ({
          test_id: c.test_id,
          status: c.status,
          failure_analysis: c.failure_analysis,
          blocked_reason: c.blocked_reason,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
