# app-validator

Pass an app **URL** (+ optional **username/password**) → Chrome explores and validates → **pass/fail** + **PDF**.

Timestamps use **Asia/Calcutta**. Excel is optional.

## One flow (recommended)

```bash
git clone https://github.com/Faizan-techahead/app-validator-agent.git
cd app-validator-agent
npm install

# Chrome headed by default; auto-finds /Applications/Google Chrome.app
npm run validate -- \
  --url https://mizzou-stage-web.virtualintros.com/ \
  --username 'YOUR_USER' \
  --password 'YOUR_PASSWORD'
```

Output JSON includes `summary` and `pdf_path` under `reports/`. Never commit or paste passwords into chat.

Optional: `export CHROME_PATH="/Applications/Google Chrome.app"` · `export APP_VALIDATOR_HEADED=0` for headless CDP.

## HTTP (same idea)

```bash
export APP_VALIDATOR_API_TOKEN='your-long-random-token'
npm run api
```

```bash
curl -sS -X POST http://127.0.0.1:8788/v1/validate/simple \
  -H "Authorization: Bearer $APP_VALIDATOR_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://mizzou-stage-web.virtualintros.com/","username":"…","password":"…","app_name":"Mizzou"}'
```

Full brief + Excel still available at `POST /v1/validate` if needed.

## Cursor playground / deploy

```bash
npx --yes "@grok/agent-sdk@0.7.0" login
npx --yes "@grok/agent-sdk@0.7.0" validate --dir .
npx --yes "@grok/agent-sdk@0.7.0" dev .
```
