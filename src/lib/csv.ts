/**
 * Minimal RFC 4180 CSV parser: commas, double-quoted fields, "" escapes, quoted newlines,
 * CRLF or LF line endings, optional UTF-8 BOM. Blank lines are skipped.
 * Returns rows with the 1-based line number each row starts on, for error reports.
 */
export type CsvRow = { line: number; cells: string[] };

export class CsvParseError extends Error {
  constructor(readonly line: number, message: string) {
    super(`Line ${line}: ${message}`);
  }
}

export function parseCsv(text: string): CsvRow[] {
  const src = text.replace(/^﻿/, "");
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowStart = 1;
  let fieldStarted = false;

  const endField = () => {
    cells.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    if (!(cells.length === 1 && cells[0] === "")) rows.push({ line: rowStart, cells });
    cells = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      if (fieldStarted) throw new CsvParseError(line, "a quote can only start a field; wrap the whole field in quotes");
      quoted = true;
      fieldStarted = true;
    } else if (c === ",") {
      endField();
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      endRow();
      line++;
      rowStart = line;
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (quoted) throw new CsvParseError(rowStart, "a quoted field is not closed");
  if (field !== "" || cells.length > 0) endRow();
  return rows;
}

/** First row as lower-case trimmed headers; the rest as objects keyed by header. */
export function csvToRecords(text: string): { headers: string[]; records: Array<{ line: number; values: Record<string, string> }> } {
  const [head, ...body] = parseCsv(text);
  if (!head) return { headers: [], records: [] };
  const headers = head.cells.map((h) => h.trim().toLowerCase());
  return {
    headers,
    records: body.map((r) => ({
      line: r.line,
      values: Object.fromEntries(headers.map((h, i) => [h, (r.cells[i] ?? "").trim()])),
    })),
  };
}
