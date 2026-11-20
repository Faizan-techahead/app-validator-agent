import { createHash } from "node:crypto";
import { decodePngToRgb, flateRgb } from "./png";
import type { FailureScreenshot, ValidationSuiteResult } from "./types";

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapLine(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > width) {
      if (cur) lines.push(cur);
      if (w.length > width) {
        for (let i = 0; i < w.length; i += width) lines.push(w.slice(i, i + width));
        cur = "";
      } else {
        cur = w;
      }
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

type TextPage = { kind: "text"; lines: string[] };
type ImagePage = {
  kind: "image";
  title: string;
  note: string;
  screenshot: FailureScreenshot;
};
type Page = TextPage | ImagePage;

function buildTextPages(suite: ValidationSuiteResult): TextPage[] {
  const all: string[] = [];
  const push = (s: string) => all.push(...wrapLine(s, 95));

  push("App Validation Report");
  push(`App: ${suite.app_name}`);
  push(`Platform: ${suite.platform}`);
  push(`Run ID: ${suite.run_id}`);
  push(`Timestamp (Asia/Calcutta): ${suite.timestamp_ist}`);
  if (suite.environment) push(`Environment: ${suite.environment}`);
  push("");
  push(
    `Summary — Pass: ${suite.summary.pass}  Fail: ${suite.summary.fail}  Blocked: ${suite.summary.blocked}  Not Run: ${suite.summary.not_run}  Total: ${suite.summary.total}`,
  );
  push("");
  push("Coverage");
  push(
    `Excel: ${suite.cases.filter((c) => c.source === "excel").length}  Generated: ${suite.cases.filter((c) => c.source === "generated").length}  Brief: ${suite.cases.filter((c) => c.source === "brief").length}`,
  );
  push("");
  push("Case results");
  for (const c of suite.cases) {
    push(
      `[${c.status.toUpperCase()}] ${c.test_id} | ${c.test_case_name} | severity=${c.severity} | source=${c.source}`,
    );
    if (c.failure_analysis) push(`  Failure analysis: ${c.failure_analysis}`);
    if (c.blocked_reason) push(`  Blocked: ${c.blocked_reason}`);
    if (c.evidence?.length) push(`  Evidence: ${c.evidence.join("; ")}`);
    if (c.status === "fail" && c.screenshot_blocked_reason) {
      push(`  Screenshot blocked: ${c.screenshot_blocked_reason}`);
    }
    if (c.status === "fail" && c.screenshot) {
      push(
        `  Screenshot: captured (${c.screenshot.mime}, ${c.screenshot.bytes ?? "?"} bytes, source=${c.screenshot.source ?? "unknown"})`,
      );
    }
  }

  push("");
  push("Failure analysis by severity");
  const fails = suite.cases.filter((c) => c.status === "fail");
  if (fails.length === 0) push("None.");
  else {
    for (const sev of ["critical", "high", "medium", "low"] as const) {
      for (const f of fails.filter((c) => c.severity === sev)) {
        push(`[${sev}] ${f.test_id}: ${f.failure_analysis ?? "failed"}`);
      }
    }
  }

  push("");
  push("Execution logs (redacted)");
  for (const c of suite.cases) {
    push(`--- ${c.test_id} (${c.status}) ---`);
    if (!c.logs?.length) push("(no logs)");
    else for (const line of c.logs) push(line);
  }

  push("");
  push("Gaps / blocked");
  const gaps = suite.cases.filter((c) => c.status === "blocked" || c.status === "not_run");
  if (gaps.length === 0) push("None.");
  else for (const g of gaps) push(`- ${g.test_id}: ${g.blocked_reason ?? g.status}`);

  push("");
  push(`Appendix — input fingerprint: ${suite.input_fingerprint}`);
  push("Secrets are never included in this report.");
  push("Failure screenshots (if any) follow on subsequent pages.");

  const pages: TextPage[] = [];
  const perPage = 48;
  for (let i = 0; i < all.length; i += perPage) {
    pages.push({ kind: "text", lines: all.slice(i, i + perPage) });
  }
  return pages.length ? pages : [{ kind: "text", lines: ["(empty report)"] }];
}

function textContentStream(lines: string[]): string {
  const contentLines: string[] = ["BT", "/F1 10 Tf", "50 780 Td", "14 TL"];
  for (let i = 0; i < lines.length; i++) {
    const t = pdfEscape(lines[i]!);
    if (i === 0) contentLines.push(`(${t}) Tj`);
    else contentLines.push(`T* (${t}) Tj`);
  }
  contentLines.push("ET");
  return contentLines.join("\n");
}

function imageContentStream(title: string, note: string): string {
  return [
    "BT",
    "/F1 12 Tf",
    "50 760 Td",
    `(${pdfEscape(title)}) Tj`,
    "0 -16 Td",
    "/F1 9 Tf",
    `(${pdfEscape(note)}) Tj`,
    "ET",
    "q",
    "512 0 0 288 50 400 cm",
    "/Im1 Do",
    "Q",
  ].join("\n");
}

function encodeImageObject(shot: FailureScreenshot): { dict: string; stream: Buffer } {
  const raw = Buffer.from(shot.base64, "base64");
  if (shot.mime === "image/jpeg") {
    let width = 1280;
    let height = 720;
    for (let i = 0; i < raw.length - 9; i++) {
      if (raw[i] === 0xff && raw[i + 1]! >= 0xc0 && raw[i + 1]! <= 0xc3) {
        height = raw.readUInt16BE(i + 5);
        width = raw.readUInt16BE(i + 7);
        break;
      }
    }
    return {
      dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${raw.length} >>`,
      stream: raw,
    };
  }
  const decoded = decodePngToRgb(raw);
  const flate = flateRgb(decoded.rgb);
  return {
    dict: `<< /Type /XObject /Subtype /Image /Width ${decoded.width} /Height ${decoded.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${flate.length} >>`,
    stream: flate,
  };
}

type PdfObject = { bytes: Buffer };

function streamObj(content: string): PdfObject {
  const body = `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream\n`;
  return { bytes: Buffer.from(body, "utf8") };
}

function dictObj(dict: string): PdfObject {
  return { bytes: Buffer.from(`${dict}\n`, "utf8") };
}

function imageXObject(dict: string, stream: Buffer): PdfObject {
  return {
    bytes: Buffer.concat([
      Buffer.from(`${dict}\nstream\n`, "utf8"),
      stream,
      Buffer.from("\nendstream\n", "utf8"),
    ]),
  };
}

/** Multi-page PDF: summary/logs text pages + one page per failure screenshot. */
export function renderValidationPdf(suite: ValidationSuiteResult): Uint8Array {
  const pages: Page[] = [
    ...buildTextPages(suite),
    ...suite.cases
      .filter((c) => c.status === "fail" && c.screenshot)
      .map(
        (c): ImagePage => ({
          kind: "image",
          title: `Failure screenshot — ${c.test_id}`,
          note: `${c.test_case_name} | ${c.screenshot!.mime} | source=${c.screenshot!.source ?? "unknown"}`,
          screenshot: c.screenshot!,
        }),
      ),
  ];

  // Object plan:
  // 1 Catalog, 2 Pages, 3 Font, then per-page content (+ optional image) + page dicts.
  const objects: PdfObject[] = [];
  objects.push(dictObj("<< /Type /Catalog /Pages 2 0 R >>")); // 1
  objects.push(dictObj("<< /Type /Pages /Kids [] /Count 0 >>")); // 2 placeholder
  objects.push(dictObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")); // 3

  const pageObjectNumbers: number[] = [];

  for (const page of pages) {
    if (page.kind === "text") {
      const contentNum = objects.length + 1;
      objects.push(streamObj(textContentStream(page.lines)));
      const pageNum = objects.length + 1;
      objects.push(
        dictObj(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
        ),
      );
      pageObjectNumbers.push(pageNum);
    } else {
      let contentStream: string;
      let resources: string;
      try {
        const img = encodeImageObject(page.screenshot);
        const imgNum = objects.length + 1;
        objects.push(imageXObject(img.dict, img.stream));
        contentStream = imageContentStream(page.title, page.note);
        resources = `/Font << /F1 3 0 R >> /XObject << /Im1 ${imgNum} 0 R >>`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        contentStream = textContentStream([
          page.title,
          `Screenshot embed failed: ${msg}`,
          page.note,
        ]);
        resources = `/Font << /F1 3 0 R >>`;
      }
      const contentNum = objects.length + 1;
      objects.push(streamObj(contentStream));
      const pageNum = objects.length + 1;
      objects.push(
        dictObj(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << ${resources} >> >>`,
        ),
      );
      pageObjectNumbers.push(pageNum);
    }
  }

  objects[1] = dictObj(
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageObjectNumbers.length} >>`,
  );

  let pdf = Buffer.from("%PDF-1.4\n", "utf8");
  const offsets: number[] = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf = Buffer.concat([
      pdf,
      Buffer.from(`${i + 1} 0 obj\n`, "utf8"),
      objects[i]!.bytes,
      Buffer.from("endobj\n", "utf8"),
    ]);
  }
  const xrefStart = pdf.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new Uint8Array(
    Buffer.concat([pdf, Buffer.from(xref, "utf8"), Buffer.from(trailer, "utf8")]),
  );
}

export function fingerprintPayload(value: unknown): string {
  const json = JSON.stringify(value);
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

export function nowIstIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Calcutta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(new Date())
    .replace(",", "");
}
