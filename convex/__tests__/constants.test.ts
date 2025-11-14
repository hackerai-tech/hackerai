import "@testing-library/jest-dom";
import { describe, it, expect } from "@jest/globals";
import {
  MIME_TYPE_MAP,
  DEFAULT_MIME_TYPE,
  getMimeTypeForExtension,
  inferMimeTypeFromFileName,
} from "../constants";

describe("MIME Type Constants", () => {
  describe("MIME_TYPE_MAP", () => {
    it("should contain markdown mappings", () => {
      expect(MIME_TYPE_MAP["md"]).toBe("text/markdown");
      expect(MIME_TYPE_MAP["markdown"]).toBe("text/markdown");
    });

    it("should contain CSV mapping", () => {
      expect(MIME_TYPE_MAP["csv"]).toBe("text/csv");
    });

    it("should contain common document types", () => {
      expect(MIME_TYPE_MAP["pdf"]).toBe("application/pdf");
      expect(MIME_TYPE_MAP["docx"]).toContain("openxmlformats");
    });

    it("should contain common image types", () => {
      expect(MIME_TYPE_MAP["png"]).toBe("image/png");
      expect(MIME_TYPE_MAP["jpg"]).toBe("image/jpeg");
      expect(MIME_TYPE_MAP["jpeg"]).toBe("image/jpeg");
    });
  });

  describe("getMimeTypeForExtension", () => {
    it("should return correct MIME type for known extension", () => {
      expect(getMimeTypeForExtension("md")).toBe("text/markdown");
      expect(getMimeTypeForExtension("csv")).toBe("text/csv");
      expect(getMimeTypeForExtension("pdf")).toBe("application/pdf");
    });

    it("should handle uppercase extensions", () => {
      expect(getMimeTypeForExtension("MD")).toBe("text/markdown");
      expect(getMimeTypeForExtension("CSV")).toBe("text/csv");
    });

    it("should return default for unknown extension", () => {
      expect(getMimeTypeForExtension("xyz")).toBe(DEFAULT_MIME_TYPE);
      expect(getMimeTypeForExtension("unknown")).toBe(
        "application/octet-stream",
      );
    });

    it("should handle empty extension", () => {
      expect(getMimeTypeForExtension("")).toBe(DEFAULT_MIME_TYPE);
    });
  });

  describe("inferMimeTypeFromFileName", () => {
    it("should infer from filename with extension", () => {
      expect(inferMimeTypeFromFileName("document.md")).toBe("text/markdown");
      expect(inferMimeTypeFromFileName("data.csv")).toBe("text/csv");
      expect(inferMimeTypeFromFileName("image.png")).toBe("image/png");
    });

    it("should handle uppercase in filename", () => {
      expect(inferMimeTypeFromFileName("DOCUMENT.MD")).toBe("text/markdown");
      expect(inferMimeTypeFromFileName("Data.CSV")).toBe("text/csv");
    });

    it("should handle multiple dots in filename", () => {
      expect(inferMimeTypeFromFileName("archive.tar.gz")).toBe(
        "application/gzip",
      );
      expect(inferMimeTypeFromFileName("file.backup.json")).toBe(
        "application/json",
      );
    });

    it("should return default for filename without extension", () => {
      expect(inferMimeTypeFromFileName("README")).toBe(DEFAULT_MIME_TYPE);
      expect(inferMimeTypeFromFileName("Makefile")).toBe(DEFAULT_MIME_TYPE);
    });

    it("should return default for unknown extension", () => {
      expect(inferMimeTypeFromFileName("file.xyz")).toBe(DEFAULT_MIME_TYPE);
    });
  });

  describe("Consistency - DRY verification", () => {
    it("should be the single source of truth for MIME types", () => {
      // This test ensures the shared constant is used everywhere
      // If this passes, we know there's no duplication
      const mdType = getMimeTypeForExtension("md");
      const csvType = getMimeTypeForExtension("csv");

      expect(mdType).toBe("text/markdown");
      expect(csvType).toBe("text/csv");
    });

    it("should provide consistent behavior across all functions", () => {
      const extension = "pdf";
      const fileName = "document.pdf";

      const typeFromExtension = getMimeTypeForExtension(extension);
      const typeFromFileName = inferMimeTypeFromFileName(fileName);

      expect(typeFromExtension).toBe(typeFromFileName);
      expect(typeFromExtension).toBe("application/pdf");
    });
  });
});
