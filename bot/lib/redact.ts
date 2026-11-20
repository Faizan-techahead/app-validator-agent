/** Redact secret-like values from execution logs before they enter reports. */

const SECRET_LINE =
  /(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|authorization|private[_-]?key)\s*[=:]\s*([^\s,;]+)/gi;

const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;

export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_LINE, (_m, key: string) => `${key}=[REDACTED]`)
    .replace(JWT_LIKE, "[REDACTED_JWT]")
    .replace(LONG_HEX, "[REDACTED_HEX]");
}

export function redactLogLines(lines: string[]): string[] {
  return lines.map((line) => redactSecrets(line)).filter((line) => line.trim().length > 0);
}
