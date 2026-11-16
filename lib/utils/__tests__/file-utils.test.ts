import {
  canPreviewImageInline,
  isPdfFile,
  isTextViewableFile,
} from "../file-utils";

describe("canPreviewImageInline", () => {
  it.each([
    ["image/dng", "original"],
    ["image/x-dng", "original"],
    ["image/X-Adobe-DNG; charset=binary", "original"],
    ["image/jpeg", "IMG_0042.DNG"],
    ["image/tiff", "camera-original.dng"],
  ])("keeps %s named %s as a file card", (mediaType, fileName) => {
    expect(canPreviewImageInline(mediaType, fileName)).toBe(false);
  });

  it.each([
    ["image/png", "screenshot.png"],
    ["image/svg+xml", "diagram.svg"],
    ["image/heic", "photo.heic"],
    ["image/jpeg", undefined],
  ])("keeps the existing inline preview for %s", (mediaType, fileName) => {
    expect(canPreviewImageInline(mediaType, fileName)).toBe(true);
  });

  it("does not preview attachments without an image media type", () => {
    expect(canPreviewImageInline(undefined, "photo.png")).toBe(false);
    expect(canPreviewImageInline("application/pdf", "report.pdf")).toBe(false);
  });
});

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
