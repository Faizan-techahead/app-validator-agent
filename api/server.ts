/**
 * Thin HTTP API for non-Cursor clients (ChatGPT Actions, scripts, bots).
 * Reuses bot/lib validation pipeline. Auth: Bearer APP_VALIDATOR_API_TOKEN.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { runValidationPipeline } from "../bot/lib/pipeline";
import type { ApplicationBrief, ColumnMapping, MobilePlatform } from "../bot/lib/types";
import { redactSecrets } from "../bot/lib/redact";

const PORT = Number(process.env.APP_VALIDATOR_API_PORT ?? process.env.PORT ?? 8788);
const HOST = process.env.APP_VALIDATOR_API_HOST ?? "127.0.0.1";
const TOKEN = process.env.APP_VALIDATOR_API_TOKEN ?? "";

type ValidateBody = {
  brief: ApplicationBrief;
  platform?: "web" | "mobile";
  mobile_os?: MobilePlatform;
  sheet_path?: string;
  sheet_url?: string;
  sheet_base64?: string;
  sheet_filename?: string;
  column_mapping?: ColumnMapping;
  environment?: string;
  pdf_mode?: "base64" | "path" | "both";
};

function logLine(msg: string): void {
  console.error(redactSecrets(msg));
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function getBearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() ?? null;
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!TOKEN) {
    json(res, 503, {
      error: "server_misconfigured",
      message: "APP_VALIDATOR_API_TOKEN is not set.",
    });
    return false;
  }
  const got = getBearer(req);
  if (!got || !safeEqual(got, TOKEN)) {
    json(res, 401, { error: "unauthorized", message: "Valid Bearer token required." });
    return false;
  }
  return true;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(raw);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function openApiDoc() {
  return {
    openapi: "3.0.3",
    info: {
      title: "app-validator HTTP API",
      version: "1.0.0",
      description:
        "Run app validation (brief + optional Excel/CSV) and return JSON summary + PDF. Asia/Calcutta timestamps in reports.",
    },
    servers: [{ url: `http://${HOST}:${PORT}` }],
    paths: {
      "/health": {
        get: {
          summary: "Liveness",
          security: [],
          responses: { "200": { description: "ok" } },
        },
      },
      "/v1/validate": {
        post: {
          summary: "Run validation suite",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ValidateRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Validation completed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ValidateResponse" },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "400": { description: "Bad request" },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas: {
        ValidateRequest: {
          type: "object",
          required: ["brief"],
          properties: {
            brief: { type: "object", description: "Application brief" },
            platform: { type: "string", enum: ["web", "mobile"] },
            mobile_os: { type: "string", enum: ["android", "ios"] },
            sheet_path: { type: "string" },
            sheet_url: { type: "string", format: "uri" },
            sheet_base64: { type: "string", description: "Raw file bytes, base64" },
            sheet_filename: { type: "string", example: "cases.xlsx" },
            column_mapping: { type: "object" },
            environment: { type: "string" },
            pdf_mode: { type: "string", enum: ["base64", "path", "both"], default: "both" },
          },
        },
        ValidateResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            run_id: { type: "string" },
            platform: { type: "string" },
            summary: { type: "object" },
            catalog_count: { type: "integer" },
            pdf_path: { type: "string" },
            pdf_base64: { type: "string" },
            pdf_bytes: { type: "integer" },
            cases: { type: "array", items: { type: "object" } },
            error: { type: "string" },
          },
        },
      },
    },
  };
}

function downloadSheet(url: string, filename: string): string {
  const dir = join(process.cwd(), "reports", "uploads");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, filename.replace(/[^\w.\-]+/g, "_"));
  const r = spawnSync("curl", ["-fsSL", "--max-time", "30", "-o", dest, url], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`Failed to download sheet_url: ${r.stderr || r.error?.message || r.status}`);
  }
  return dest;
}

function writeSheetBase64(b64: string, filename: string): string {
  const dir = join(process.cwd(), "reports", "uploads");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, filename.replace(/[^\w.\-]+/g, "_"));
  writeFileSync(dest, Buffer.from(b64, "base64"));
  return dest;
}

async function handleValidate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  let body: ValidateBody;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString("utf8")) as ValidateBody;
  } catch {
    json(res, 400, { error: "invalid_json", message: "Body must be JSON." });
    return;
  }
  if (!body?.brief?.app_name || !body.brief.app_type) {
    json(res, 400, {
      error: "invalid_brief",
      message: "brief.app_name and brief.app_type are required.",
    });
    return;
  }

  let sheet_path = body.sheet_path;
  try {
    if (body.sheet_base64) {
      const name = body.sheet_filename ?? "upload.xlsx";
      sheet_path = writeSheetBase64(body.sheet_base64, `${Date.now()}_${name}`);
    } else if (body.sheet_url) {
      const name = body.sheet_filename ?? "download.xlsx";
      sheet_path = downloadSheet(body.sheet_url, `${Date.now()}_${name}`);
    }
  } catch (err) {
    json(res, 400, {
      error: "sheet_load_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  logLine(`validate start platform=${body.platform ?? body.brief.app_type} sheet=${sheet_path ? "yes" : "no"}`);
  const result = await runValidationPipeline({
    brief: body.brief,
    platform: body.platform,
    mobile_os: body.mobile_os,
    sheet_path,
    column_mapping: body.column_mapping,
    environment: body.environment,
    pdf_mode: body.pdf_mode ?? "both",
  });

  if (!result.ok) {
    json(res, 400, {
      ok: false,
      error: result.error,
      issues: result.issues,
      run_id: result.run_id,
      platform: result.platform,
    });
    return;
  }

  json(res, 200, {
    ok: true,
    run_id: result.run_id,
    platform: result.platform,
    catalog_count: result.catalog_count,
    summary: result.summary,
    cases: result.suite?.cases.map((c) => ({
      test_id: c.test_id,
      test_case_name: c.test_case_name,
      status: c.status,
      severity: c.severity,
      source: c.source,
      failure_analysis: c.failure_analysis,
      blocked_reason: c.blocked_reason,
      logs: c.logs,
      has_screenshot: Boolean(c.screenshot),
      screenshot_blocked_reason: c.screenshot_blocked_reason,
    })),
    pdf_path: result.pdf_path,
    pdf_base64: result.pdf_base64,
    pdf_bytes: result.pdf_bytes,
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, service: "app-validator-api" });
      return;
    }
    if (req.method === "GET" && (url.pathname === "/openapi.json" || url.pathname === "/v1/openapi.json")) {
      json(res, 200, openApiDoc());
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/validate") {
      await handleValidate(req, res);
      return;
    }
    json(res, 404, { error: "not_found" });
  } catch (err) {
    logLine(`handler error: ${err instanceof Error ? err.message : String(err)}`);
    json(res, 500, { error: "internal_error" });
  }
});

server.listen(PORT, HOST, () => {
  logLine(`app-validator API listening on http://${HOST}:${PORT}`);
  if (!TOKEN) logLine("WARNING: APP_VALIDATOR_API_TOKEN is unset; /v1/validate will return 503.");
});
