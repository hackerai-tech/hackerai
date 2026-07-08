import { isPdfFile, isTextViewableFile } from "../file-utils";

describe("file-utils preview classification", () => {
  it("treats application/pdf files as PDFs", () => {
    const file = new File(["%PDF-1.7"], "report.pdf", {
      type: "application/pdf",
    });

    expect(isPdfFile(file)).toBe(true);
  });

  it("does not classify .pdf filenames as PDFs without the PDF media type", () => {
    const htmlFile = new File(["<script>alert(1)</script>"], "report.pdf", {
      type: "text/html",
    });
    const unknownFile = new File(["%PDF-1.7"], "report.pdf");

    expect(isPdfFile(htmlFile)).toBe(false);
    expect(isPdfFile(unknownFile)).toBe(false);
    expect(isTextViewableFile(htmlFile)).toBe(true);
  });
});
