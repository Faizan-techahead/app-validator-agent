import { inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import type { ColumnMapping, NormalizedCase, CaseSeverity, AppType, CaseSource } from "./types";

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const APP_TYPES = new Set(["web", "mobile", "hybrid", "api", "docs_only"]);

const HEADER_ALIASES: Record<keyof Required<ColumnMapping>, string[]> = {
  test_case_name: ["test_case_name", "testcase", "test_case", "name", "title", "case_name"],
  steps: ["steps", "step", "actions", "procedure", "test_steps"],
  expected_result: ["expected_result", "expected", "expected_outcome", "assertion"],
  preconditions: ["preconditions", "precondition", "setup", "prereq"],
  severity: ["severity", "priority", "prio"],
  app_type: ["app_type", "platform", "type", "target"],
  test_id: ["test_id", "id", "case_id", "tc_id"],
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function resolveMapping(
  headers: string[],
  mapping?: ColumnMapping,
): Record<keyof Required<ColumnMapping>, number | undefined> {
  const normHeaders = headers.map(normalizeHeader);
  const out: Record<keyof Required<ColumnMapping>, number | undefined> = {
    test_case_name: undefined,
    steps: undefined,
    expected_result: undefined,
    preconditions: undefined,
    severity: undefined,
    app_type: undefined,
    test_id: undefined,
  };

  for (const key of Object.keys(HEADER_ALIASES) as Array<keyof Required<ColumnMapping>>) {
    const override = mapping?.[key];
    if (override) {
      const idx = normHeaders.indexOf(normalizeHeader(override));
      if (idx >= 0) out[key] = idx;
      continue;
    }
    for (const alias of HEADER_ALIASES[key]) {
      const idx = normHeaders.indexOf(alias);
      if (idx >= 0) {
        out[key] = idx;
        break;
      }
    }
  }
  return out;
}

function splitSteps(raw: string): string[] {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const numbered = text.split(/\n+/).map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);
  if (numbered.length > 1) return numbered;
  const bySemi = text.split(/;\s+/).map((s) => s.trim()).filter(Boolean);
  return bySemi.length > 1 ? bySemi : [text];
}

function parseSeverity(v: string | undefined): CaseSeverity {
  const s = (v ?? "medium").trim().toLowerCase();
  return SEVERITIES.has(s) ? (s as CaseSeverity) : "medium";
}

function parseAppType(v: string | undefined): AppType | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase();
  return APP_TYPES.has(s) ? (s as AppType) : undefined;
}

function slugId(name: string, index: number): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
  return `tc_${String(index + 1).padStart(3, "0")}_${base || "case"}`;
}

export function rowsToCases(
  headers: string[],
  rows: string[][],
  opts?: { mapping?: ColumnMapping; source?: CaseSource },
): { cases: NormalizedCase[]; warnings: string[]; mapping_used: Record<string, string | null> } {
  const map = resolveMapping(headers, opts?.mapping);
  const warnings: string[] = [];
  const mapping_used: Record<string, string | null> = {};
  for (const key of Object.keys(map) as Array<keyof typeof map>) {
    mapping_used[key] = map[key] === undefined ? null : headers[map[key]!];
  }

  if (map.test_case_name === undefined || map.steps === undefined) {
    throw new Error(
      "Excel import requires columns for test case name and steps. Pass columnMapping or use recognizable headers.",
    );
  }

  const cases: NormalizedCase[] = [];
  rows.forEach((row, index) => {
    const name = (row[map.test_case_name!] ?? "").trim();
    const stepsRaw = (row[map.steps!] ?? "").trim();
    if (!name && !stepsRaw) return;
    if (!name || !stepsRaw) {
      warnings.push(`Row ${index + 2}: incomplete (missing name or steps); skipped.`);
      return;
    }
    const providedId = map.test_id !== undefined ? (row[map.test_id] ?? "").trim() : "";
    cases.push({
      test_id: providedId || slugId(name, index),
      test_case_name: name,
      steps: splitSteps(stepsRaw),
      expected_result:
        map.expected_result !== undefined
          ? (row[map.expected_result] ?? "").trim() || undefined
          : undefined,
      preconditions:
        map.preconditions !== undefined
          ? (row[map.preconditions] ?? "").trim() || undefined
          : undefined,
      severity: parseSeverity(
        map.severity !== undefined ? row[map.severity] : undefined,
      ),
      app_type: parseAppType(
        map.app_type !== undefined ? row[map.app_type] : undefined,
      ),
      source: opts?.source ?? "excel",
    });
  });

  return { cases, warnings, mapping_used };
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    return cells;
  };
  const headers = parseLine(lines[0]!);
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

/** Minimal ZIP reader for store/deflate local file entries. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const uncompSize = buf.readUInt32LE(offset + 22);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
    const dataStart = offset + 30 + nameLen + extraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`Unsupported ZIP method ${method} for ${name}`);
    if (uncompSize && data.length !== uncompSize && method === 0) {
      // ignore mismatch for stored with zero sizes in some writers
    }
    out.set(name, data);
    offset = dataStart + compSize;
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml))) {
    const inner = m[1]!;
    const texts = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) =>
      decodeXmlEntities(x[1]!),
    );
    strings.push(texts.join(""));
  }
  return strings;
}

function colLettersToIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function parseSheetRows(xml: string, shared: string[]): string[][] {
  const rows = new Map<number, Map<number, string>>();
  const rowRe = /<row\b[^>]*?(?: r="(\d+)")?[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  let implicitRow = 0;
  while ((rm = rowRe.exec(xml))) {
    const rowNum = rm[1] ? Number(rm[1]) - 1 : implicitRow;
    implicitRow = rowNum + 1;
    const cells = new Map<number, string>();
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[2] ?? ""))) {
      const attrs = cm[1] ?? cm[3] ?? "";
      const body = cm[2] ?? "";
      const ref = /r="([A-Z]+)(\d+)"/.exec(attrs);
      const colIdx = ref ? colLettersToIndex(ref[1]!) : cells.size;
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      let value = "";
      if (type === "s") {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        value = shared[Number(v)] ?? "";
      } else if (type === "inlineStr") {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
          .map((x) => decodeXmlEntities(x[1]!))
          .join("");
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        value = decodeXmlEntities(v);
      }
      cells.set(colIdx, value);
    }
    rows.set(rowNum, cells);
  }

  const maxRow = Math.max(-1, ...rows.keys());
  const result: string[][] = [];
  for (let r = 0; r <= maxRow; r++) {
    const cells = rows.get(r) ?? new Map();
    const maxCol = Math.max(-1, ...cells.keys());
    const line: string[] = [];
    for (let c = 0; c <= maxCol; c++) line.push(cells.get(c) ?? "");
    result.push(line);
  }
  return result;
}

function parseXlsx(buf: Buffer): { headers: string[]; rows: string[][] } {
  const files = unzip(buf);
  const sharedXml = files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const shared = sharedXml ? parseSharedStrings(sharedXml) : [];
  const sheet =
    files.get("xl/worksheets/sheet1.xml")?.toString("utf8") ??
    [...files.entries()].find(([k]) => k.startsWith("xl/worksheets/sheet"))?.[1]?.toString(
      "utf8",
    );
  if (!sheet) throw new Error("No worksheet found in xlsx.");
  const table = parseSheetRows(sheet, shared).filter((r) => r.some((c) => c.trim()));
  if (table.length === 0) return { headers: [], rows: [] };
  return { headers: table[0]!, rows: table.slice(1) };
}

export function loadTabularFile(
  filePath: string,
): { headers: string[]; rows: string[][]; format: string } {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".json")) {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (Array.isArray(raw)) {
      if (raw.length === 0) return { headers: [], rows: [], format: "json" };
      const headers = Object.keys(raw[0] as object);
      const rows = raw.map((obj) =>
        headers.map((h) => String((obj as Record<string, unknown>)[h] ?? "")),
      );
      return { headers, rows, format: "json" };
    }
    throw new Error("JSON fixture must be an array of row objects.");
  }
  if (lower.endsWith(".csv")) {
    const { headers, rows } = parseCsv(readFileSync(filePath, "utf8"));
    return { headers, rows, format: "csv" };
  }
  if (lower.endsWith(".xlsx")) {
    const { headers, rows } = parseXlsx(readFileSync(filePath));
    return { headers, rows, format: "xlsx" };
  }
  throw new Error("Supported formats: .xlsx, .csv, .json");
}
