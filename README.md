# app-validator

Agent SDK agent that validates web (Chrome) or mobile (local emulator) apps from a brief and/or Excel test sheet, scores Pass/Fail/Blocked/Not Run, and writes a PDF report with redacted execution logs and failure screenshots.

Timestamps in reports use **Asia/Calcutta**.

## Clone and install

```bash
git clone https://github.com/Faizan-techahead/app-validator-agent.git
cd app-validator-agent
npm install
```

## Login (once per machine, for playground / deploy)

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

## HTTP API (ChatGPT Actions / scripts / other bots)

Synchronous JSON + PDF for non-Cursor clients. Uses the same TypeScript pipeline as the agent tools (not a hosted 202 webhook).

```bash
cp env.example .env.local
export APP_VALIDATOR_API_TOKEN='your-long-random-token'
npm run api
# http://127.0.0.1:8788/health
# http://127.0.0.1:8788/openapi.json
```

Brief only (no Excel) — auto-generates generic exploratory web cases from `base_url`:

```bash
curl -sS -X POST http://127.0.0.1:8788/v1/validate \
  -H "Authorization: Bearer $APP_VALIDATOR_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "brief": {
      "app_name": "Mizzou",
      "app_type": "web",
      "base_url": "https://mizzou-stage-web.virtualintros.com/"
    },
    "platform": "web",
    "pdf_mode": "path"
  }'
```

URL + login via env refs (preferred — never put passwords in the JSON body or logs):

```bash
export MIZZOU_USER='…'
export MIZZOU_PASSWORD='…'
curl -sS -X POST http://127.0.0.1:8788/v1/validate \
  -H "Authorization: Bearer $APP_VALIDATOR_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "brief": {
      "app_name": "Mizzou",
      "app_type": "web",
      "base_url": "https://mizzou-stage-web.virtualintros.com/"
    },
    "platform": "web",
    "login": {
      "username_env": "MIZZOU_USER",
      "password_env": "MIZZOU_PASSWORD"
    },
    "pdf_mode": "path"
  }'
```

With a sheet (optional):

```bash
curl -sS -X POST http://127.0.0.1:8788/v1/validate \
  -H "Authorization: Bearer $APP_VALIDATOR_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "brief": {
      "app_name": "Demo Catalog App",
      "app_type": "web",
      "base_url": "https://example.com"
    },
    "platform": "web",
    "sheet_path": "evals/fixtures/sample-cases.xlsx",
    "pdf_mode": "path"
  }'
```

Full OpenAPI-ish contract: Project store `docs/app-validator-http-api.md`.

## Deploy (team hosting)

Do this on a machine where you can keep the one-time **alias token** (password manager). Do **not** print the token in chat.

```bash
npx --yes "@grok/agent-sdk@0.7.0" validate --dir .
npx --yes "@grok/agent-sdk@0.7.0" deploy --dir . --dry-run
npx --yes "@grok/agent-sdk@0.7.0" deploy --dir .
```

Manage at https://cursor.com/dashboard/deployed-agents

The hosted Agent SDK deployment serves the playground/model agent. The **HTTP API** is run separately (`npm run api`) on a machine that can reach Chrome / emulators as needed.

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

- Channels: playground + HTTP agent routes; plus standalone `api/server.ts` for external callers.
- Mobile execution and emulator screenshots belong on the self-hosted worker that hosts the emulator.
- Never put passwords, tokens, or PII in Excel, chat, or the PDF.
