import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  FileApiAdapter,
  normalizeFile,
  getContentType,
  isImage,
} from "../file-api-adapter";

describe("File API Adapter", () => {
  let adapter: FileApiAdapter;

  beforeEach(() => {
    adapter = new FileApiAdapter();
    adapter.resetStats();
  });

  describe("getContentType", () => {
    it("should return browser-provided MIME type when available", () => {
      const file = new File(["content"], "test.pdf", { type: "application/pdf" });
      expect(getContentType(file)).toBe("application/pdf");
    });

    it("should infer MIME type from extension when file.type is empty (MD files)", () => {
      const file = new File(["# Markdown"], "document.md", { type: "" });
      expect(getContentType(file)).toBe("text/markdown");
    });

    it("should infer MIME type from extension when file.type is empty (CSV files)", () => {
      const file = new File(["col1,col2\nval1,val2"], "data.csv", { type: "" });
      expect(getContentType(file)).toBe("text/csv");
    });

    it("should handle uppercase extensions", () => {
      const file = new File(["content"], "DOCUMENT.MD", { type: "" });
      expect(getContentType(file)).toBe("text/markdown");
    });

    it("should fallback to application/octet-stream for unknown extensions", () => {
      const file = new File(["content"], "file.xyz", { type: "" });
      expect(getContentType(file)).toBe("application/octet-stream");
    });

    it("should handle files without extensions", () => {
      const file = new File(["content"], "README", { type: "" });
      expect(getContentType(file)).toBe("application/octet-stream");
    });

    it("should handle files with multiple dots", () => {
      const file = new File(["content"], "archive.tar.gz", { type: "" });
      expect(getContentType(file)).toBe("application/gzip");
    });
  });

  describe("normalizeFile", () => {
    it("should normalize file with empty MIME type and set inference flag", () => {
      const file = new File(["content"], "test.md", { type: "" });
      const result = normalizeFile(file, "upload");

      expect(result.metadata.contentType).toBe("text/markdown");
      expect(result.metadata.wasContentTypeInferred).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("inferred");
    });

    it("should normalize file with valid MIME type and clear inference flag", () => {
      const file = new File(["content"], "test.pdf", { type: "application/pdf" });
      const result = normalizeFile(file, "upload");

      expect(result.metadata.contentType).toBe("application/pdf");
      expect(result.metadata.wasContentTypeInferred).toBe(false);
      expect(result.warnings.length).toBe(0);
    });

    it("should include original file in result", () => {
      const file = new File(["content"], "test.txt", { type: "text/plain" });
      const result = normalizeFile(file);

      expect(result.originalFile).toBe(file);
    });

    it("should handle paste source", () => {
      const file = new File(["content"], "test.csv", { type: "" });
      const result = normalizeFile(file, "paste");

      expect(result.warnings[0]).toContain("source: paste");
    });

    it("should handle drag-drop source", () => {
      const file = new File(["content"], "test.md", { type: "" });
      const result = normalizeFile(file, "drop");

      expect(result.warnings[0]).toContain("source: drop");
    });
  });

  describe("isImage", () => {
    it("should identify PNG images", () => {
      const file = new File(["image"], "photo.png", { type: "image/png" });
      expect(isImage(file)).toBe(true);
    });

    it("should identify JPEG images", () => {
      const file = new File(["image"], "photo.jpg", { type: "image/jpeg" });
      expect(isImage(file)).toBe(true);
    });

    it("should identify images when type is inferred from extension", () => {
      const file = new File(["image"], "photo.png", { type: "" });
      expect(isImage(file)).toBe(true);
    });

    it("should reject non-image files", () => {
      const file = new File(["content"], "doc.pdf", { type: "application/pdf" });
      expect(isImage(file)).toBe(false);
    });

    it("should reject non-image files with empty type", () => {
      const file = new File(["content"], "doc.csv", { type: "" });
      expect(isImage(file)).toBe(false);
    });
  });

  describe("FileApiAdapter statistics", () => {
    it("should track total files processed", () => {
      const file1 = new File(["content"], "test.md", { type: "" });
      const file2 = new File(["content"], "test.pdf", { type: "application/pdf" });

      adapter.normalizeFile(file1);
      adapter.normalizeFile(file2);

      const stats = adapter.getStats();
      expect(stats.totalFilesProcessed).toBe(2);
    });

    it("should track content type inference count", () => {
      const file1 = new File(["content"], "test.md", { type: "" });
      const file2 = new File(["content"], "test.csv", { type: "" });
      const file3 = new File(["content"], "test.pdf", { type: "application/pdf" });

      adapter.normalizeFile(file1);
      adapter.normalizeFile(file2);
      adapter.normalizeFile(file3);

      const stats = adapter.getStats();
      expect(stats.contentTypeInferredCount).toBe(2);
    });

    it("should reset statistics", () => {
      const file = new File(["content"], "test.md", { type: "" });
      adapter.normalizeFile(file);

      adapter.resetStats();

      const stats = adapter.getStats();
      expect(stats.totalFilesProcessed).toBe(0);
      expect(stats.contentTypeInferredCount).toBe(0);
    });
  });

  describe("Edge cases - Real-world browser behavior", () => {
    it("should handle MD files from clipboard paste (empty type)", () => {
      // Simulates real browser behavior when pasting MD files
      const file = new File(["# Header"], "document.md", { type: "" });
      const contentType = getContentType(file);

      expect(contentType).toBe("text/markdown");
      expect(contentType).not.toBe("");
    });

    it("should handle CSV files from drag-drop (empty type)", () => {
      // Simulates real browser behavior when dropping CSV files
      const file = new File(["col1,col2"], "data.csv", { type: "" });
      const contentType = getContentType(file);

      expect(contentType).toBe("text/csv");
      expect(contentType).not.toBe("");
    });

    it("should handle files with whitespace-only MIME type", () => {
      const file = new File(["content"], "test.md", { type: "   " });
      const result = adapter.normalizeFile(file);

      expect(result.metadata.contentType).toBe("text/markdown");
      expect(result.metadata.wasContentTypeInferred).toBe(true);
    });

    it("should prefer browser MIME type over extension when both available", () => {
      // File has .txt extension but browser detected it as markdown
      const file = new File(["# Header"], "README.txt", { type: "text/markdown" });
      const contentType = getContentType(file);

      expect(contentType).toBe("text/markdown");
    });
  });

  describe("Common file extensions coverage", () => {
    const testCases = [
      { extension: "md", expectedType: "text/markdown" },
      { extension: "markdown", expectedType: "text/markdown" },
      { extension: "csv", expectedType: "text/csv" },
      { extension: "json", expectedType: "application/json" },
      { extension: "txt", expectedType: "text/plain" },
      { extension: "pdf", expectedType: "application/pdf" },
      { extension: "png", expectedType: "image/png" },
      { extension: "jpg", expectedType: "image/jpeg" },
      { extension: "jpeg", expectedType: "image/jpeg" },
      { extension: "gif", expectedType: "image/gif" },
      { extension: "webp", expectedType: "image/webp" },
      { extension: "docx", expectedType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    ];

    testCases.forEach(({ extension, expectedType }) => {
      it(`should infer ${expectedType} for .${extension} files`, () => {
        const file = new File(["content"], `file.${extension}`, { type: "" });
        expect(getContentType(file)).toBe(expectedType);
      });
    });
  });
});
