# app-validator

Agent SDK agent that validates web (Chrome) or mobile (local emulator) apps from a brief and/or Excel test sheet, scores Pass/Fail/Blocked/Not Run, and writes a PDF report with redacted execution logs and failure screenshots.

Timestamps in reports use **Asia/Calcutta**.

## Clone and install

```bash
git clone <YOUR_REMOTE_URL> app-validator
cd app-validator
npm install
```

## Login (once per machine)

```bash
npx --yes "@grok/agent-sdk@0.7.0" login
```

Or set `CURSOR_API_KEY` / `CURSOR_API_KEY_FILE` / `CURSOR_SERVICE_ACCOUNT_KEY`.

## Local playground (`dev`)

```bash
npx --yes "@grok/agent-sdk@0.7.0" validate --dir .
npx tsc --noEmit -p .
npx --yes "@grok/agent-sdk@0.7.0" dev .
```

Open `http://127.0.0.1:3000/playground`.

Fixture smoke paths:

- `evals/fixtures/sample-brief.json`
- `evals/fixtures/sample-cases.xlsx`

## Deploy (team hosting)

Do this on a machine where you can keep the one-time **alias token** (password manager). Do **not** print the token in chat.

1. Push the commit you want to ship to your git remote.
2. Dry-run first:

```bash
npx --yes "@grok/agent-sdk@0.7.0" validate --dir .
npx --yes "@grok/agent-sdk@0.7.0" deploy --dir . --dry-run
```

3. Deploy for real (your terminal only):

```bash
npx --yes "@grok/agent-sdk@0.7.0" deploy --dir .
```

4. Save the alias token from the first deploy. Manage the agent at  
   https://cursor.com/dashboard/deployed-agents

5. Smoke a hosted session:

```bash
npx --yes "@grok/agent-sdk@0.7.0" session create --slug app-validator --message "Validate Demo Catalog App using the sample fixtures." --wait
```

## Tools

| Tool | Role |
| --- | --- |
| `normalize_brief` | Validate application brief |
| `import_excel_cases` | Parse `.xlsx` / `.csv` / `.json` with runtime column mapping |
| `generate_test_catalog` | Merge sheet + brief-justified gap cases |
| `run_web_chrome` | Chrome headless validation + logs; screenshot on Fail |
| `run_mobile_emulator` | Local Android/iOS emulator probe (ask platform at run time) |
| `run_validation_suite` | Score + JSON report (merges logs/screenshots) |
| `render_pdf_report` | Same PDF: summary, logs, failure screenshots |

## Notes

- Channels: playground + HTTP only (no Slack/Teams in this scaffold).
- Mobile execution and emulator screenshots belong on the self-hosted worker that hosts the emulator.
- Never put passwords, tokens, or PII in Excel, chat, or the PDF.
