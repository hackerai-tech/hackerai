import JSZip from "jszip";
import { extractDocxPreview } from "../docx-preview";

// Exercise Mammoth's actual browser adapter, as selected by the frontend bundler.
jest.mock("mammoth/lib/unzip", () =>
  jest.requireActual("mammoth/browser/unzip"),
);

const documentXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Local café 日本語</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cedar</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>&lt;script&gt;not executable&lt;/script&gt;</w:t></w:r></w:p></w:body></w:document>`;

function documentZip() {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  return zip;
}

it("extracts real DOCX paragraphs, Unicode and table cells as text", async () => {
  const bytes = await documentZip().generateAsync({ type: "arraybuffer" });
  const text = await extractDocxPreview(bytes);
  expect(text).toContain("Local café 日本語");
  expect(text).toContain("Cedar");
  expect(text).toContain("3");
  expect(text).toContain("<script>not executable</script>");
});

it("rejects malformed documents", async () => {
  await expect(extractDocxPreview(new ArrayBuffer(10))).rejects.toThrow();
});

it("rejects a small compressed archive that expands beyond the preview budget", async () => {
  const zip = documentZip();
  zip.file("word/large.xml", "x".repeat(21 * 1024 * 1024));
  const bytes = await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  });
  expect(bytes.byteLength).toBeLessThan(100_000);
  await expect(extractDocxPreview(bytes)).rejects.toThrow(
    "too large to preview",
  );
});
