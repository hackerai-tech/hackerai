const FORMULA_PREFIX = /^[=+\-@]/u;
const LEADING_IGNORABLES =
  /^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]*/u;

export function neutralizeSpreadsheetFormula(value: string): string {
  const normalizedStart = value
    .normalize("NFKC")
    .replace(LEADING_IGNORABLES, "");

  return FORMULA_PREFIX.test(normalizedStart) ? `'${value}` : value;
}

function encodeCsvCell(value: string): string {
  const literalValue = neutralizeSpreadsheetFormula(value);
  return `"${literalValue.replace(/"/g, '""')}"`;
}

export function serializeSpreadsheetCsv(rows: string[][]): string {
  return rows.map((row) => row.map(encodeCsvCell).join(",")).join("\r\n");
}

export function serializeSpreadsheetTsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((value) =>
          // Clipboard TSV has no consistently supported escaping convention,
          // so keep cell boundaries intact by flattening embedded separators.
          neutralizeSpreadsheetFormula(value.replace(/[\t\r\n]+/g, " ")),
        )
        .join("\t"),
    )
    .join("\r\n");
}
