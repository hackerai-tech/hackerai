import {
  neutralizeSpreadsheetFormula,
  serializeSpreadsheetCsv,
  serializeSpreadsheetTsv,
} from "../spreadsheet-export";

describe("spreadsheet export", () => {
  it.each([
    "=SUM(1,2)",
    "+SUM(1,2)",
    "-1+2",
    "@SUM(1,2)",
    "  =SUM(1,2)",
    "\t=SUM(1,2)",
    "＝SUM(1,2)",
    "＋SUM(1,2)",
    "－1+2",
    "＠SUM(1,2)",
    "\u200b=SUM(1,2)",
  ])("neutralizes formula-like value %j", (value) => {
    expect(neutralizeSpreadsheetFormula(value)).toBe(`'${value}`);
  });

  it.each(["plain text", "123", "1+2", "'=-1+2", "https://example.test"])(
    "leaves ordinary value %j intact",
    (value) => {
      expect(neutralizeSpreadsheetFormula(value)).toBe(value);
    },
  );

  it("quotes every CSV field and preserves delimiters, quotes, and line breaks", () => {
    expect(
      serializeSpreadsheetCsv([
        ["plain", "comma, value", 'say "hello"'],
        ["line\nbreak", "carriage\rreturn", "windows\r\nbreak"],
        ["=1+1", "-42", ""],
      ]),
    ).toBe(
      [
        '"plain","comma, value","say ""hello"""',
        '"line\nbreak","carriage\rreturn","windows\r\nbreak"',
        '"\'=1+1","\'-42",""',
      ].join("\r\n"),
    );
  });

  it("keeps TSV rows intact when cell text contains separators", () => {
    expect(
      serializeSpreadsheetTsv([
        [
          "plain",
          "embedded\ttab",
          "line\nbreak",
          "carriage\rreturn",
          "windows\r\nbreak",
        ],
        ["=1+1", "safe"],
      ]),
    ).toBe(
      "plain\tembedded tab\tline break\tcarriage return\twindows break\r\n'=1+1\tsafe",
    );
  });
});
