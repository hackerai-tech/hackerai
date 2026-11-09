import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { renderFindingsMarkdown, type FindingsReport } from "./export";

function wrapLine(
  text: string,
  font: PDFFont,
  size: number,
  width: number,
  prose: boolean,
): string[] {
  if (!text) return [""];
  const result: string[] = [];
  let line = "";
  let lineWidth = 0;
  // Prefer word boundaries in prose, while keeping long URLs and payloads
  // within the page. The attached JSON retains exact original whitespace.
  for (const character of text) {
    const nextWidth = font.widthOfTextAtSize(character, size);
    if (line && lineWidth + nextWidth > width) {
      const boundary = prose ? line.lastIndexOf(" ") : -1;
      const split = boundary > 0 ? boundary + 1 : line.length;
      result.push(line.slice(0, split));
      line = line.slice(split);
      lineWidth = font.widthOfTextAtSize(line, size);
    }
    line += character;
    lineWidth += nextWidth;
  }
  result.push(line);
  return result;
}

export async function renderFindingsPdf(
  report: FindingsReport,
  fontBytes: ArrayBuffer,
): Promise<Uint8Array<ArrayBuffer>> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  const supported = new Set(font.getCharacterSet());
  let escapedCharacters = false;
  const printable = (value: string) =>
    Array.from(value.replace(/\t/g, "    "))
      .map((char) => {
        const point = char.codePointAt(0)!;
        if (supported.has(point)) return char;
        escapedCharacters = true;
        return `[U+${point.toString(16).toUpperCase().padStart(4, "0")}]`;
      })
      .join("");
  const rawLines = renderFindingsMarkdown(report).split(/\r?\n/);
  const lines = rawLines.map(printable);
  doc.setTitle(report.title);
  doc.setAuthor("HackerAI");
  doc.setCreationDate(new Date(report.generated_at));
  // The exact record travels with the PDF, including characters outside the
  // embedded font and unwrapped request/response/PoC captures.
  await doc.attach(
    new TextEncoder().encode(JSON.stringify(report, null, 2)),
    "findings.json",
    {
      mimeType: "application/json",
      description:
        "Exact saved findings, evidence, limitations and source provenance",
    },
  );
  if (escapedCharacters)
    lines.splice(
      5,
      0,
      "Font note: characters outside this font are shown as [U+XXXX].",
      "The exact Unicode text is retained in the attached findings.json.",
      "",
    );
  let page = doc.addPage([595.28, 841.89]);
  let y = 791;
  let inCode = false;
  let fence = 0;
  for (const line of lines) {
    const match = line.match(/^(`{3,})\s*$/);
    if (match && (!inCode || match[1].length >= fence)) {
      inCode = !inCode;
      fence = inCode ? match[1].length : 0;
      continue;
    }
    const heading = !inCode ? line.match(/^(#{1,3}) (.*)$/) : null;
    const size = heading ? 16 - heading[1].length * 2 : inCode ? 8 : 9.5;
    const text = heading ? heading[2] : line;
    for (const wrapped of wrapLine(text, font, size, 507, !inCode)) {
      const advance = size * 1.55;
      if (y - advance < 48) {
        if (doc.getPageCount() >= 1_000)
          throw new Error("PDF is too large; select fewer findings");
        page = doc.addPage([595.28, 841.89]);
        y = 791;
      }
      if (wrapped)
        page.drawText(wrapped, {
          x: 44,
          y,
          size,
          font,
          color: rgb(0.09, 0.12, 0.16),
        });
      y -= advance;
    }
  }
  const pages = doc.getPages();
  pages.forEach((p, index) =>
    p.drawText(`${index + 1} / ${pages.length}  |  HackerAI`, {
      x: 44,
      y: 24,
      size: 8,
      font,
      color: rgb(0.4, 0.44, 0.48),
    }),
  );
  return new Uint8Array(await doc.save());
}
