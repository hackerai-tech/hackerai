import { parseDelimitedPreview } from "../delimited-preview";
import { workspacePreviewDocument } from "../format";

it("preserves quoted delimiters, multiline values, escaped quotes and BOM in table previews", () => {
  expect(
    parseDelimitedPreview(
      '\ufeffname,note\r\n"a,b","line 1\nline ""2"""\r\n',
      ",",
    ),
  ).toEqual({
    rows: [
      ["name", "note"],
      ["a,b", 'line 1\nline "2"'],
    ],
    truncated: false,
  });
  expect(parseDelimitedPreview("a\tb\nc\td", "\t").rows).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
});
it("bounds row, column and cell rendering while reporting truncation", () => {
  const result = parseDelimitedPreview(
    [
      Array(31).fill("x".repeat(2001)).join(","),
      ...Array(100).fill("a,b"),
    ].join("\n"),
    ",",
  );
  expect(result.rows).toHaveLength(100);
  expect(result.rows[0]).toHaveLength(30);
  expect(result.rows[0][0]).toHaveLength(2000);
  expect(result.truncated).toBe(true);
});
it("retains document content while removing code, navigation and network resource attributes", () => {
  const html = workspacePreviewDocument(
    '<h1>Report</h1><script>alert(1)</script><img src="https://tracker.invalid/x" onerror="alert(2)"><a href="javascript:alert(3)">link</a><meta http-equiv="refresh" content="0;url=https://tracker.invalid"><iframe src="https://tracker.invalid"></iframe><form action="https://tracker.invalid"><input></form><svg onload="alert(4)"></svg>',
  );
  const doc = new DOMParser().parseFromString(html, "text/html");
  expect(doc.querySelector("h1")?.textContent).toBe("Report");
  expect(
    doc.body.querySelector("script, iframe, form, input, svg, meta"),
  ).toBeNull();
  expect(
    doc.body.querySelector("[src], [href], [onerror], [onload]"),
  ).toBeNull();
  expect(
    doc.head
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content"),
  ).toContain("default-src 'none'");
});
