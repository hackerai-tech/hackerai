import "@testing-library/jest-dom";
import { describe, it, expect } from "@jest/globals";
import {
  isSupportedFileMediaType,
  isSupportedImageMediaType,
} from "../file-utils";

describe("File Media Type Utilities", () => {
  describe("isSupportedFileMediaType", () => {
    it("should return true for PDF files", () => {
      expect(isSupportedFileMediaType("application/pdf")).toBe(true);
    });

    it("should return true for CSV files", () => {
      expect(isSupportedFileMediaType("text/csv")).toBe(true);
    });

    it("should return true for Markdown files", () => {
      expect(isSupportedFileMediaType("text/markdown")).toBe(true);
    });

    it("should return true for plain text files", () => {
      expect(isSupportedFileMediaType("text/plain")).toBe(true);
    });

    it("should return true for HTML files", () => {
      expect(isSupportedFileMediaType("text/html")).toBe(true);
    });

    it("should handle uppercase MIME types", () => {
      expect(isSupportedFileMediaType("APPLICATION/PDF")).toBe(true);
      expect(isSupportedFileMediaType("TEXT/CSV")).toBe(true);
      expect(isSupportedFileMediaType("TEXT/MARKDOWN")).toBe(true);
    });

    it("should handle mixed case MIME types", () => {
      expect(isSupportedFileMediaType("Application/PDF")).toBe(true);
      expect(isSupportedFileMediaType("Text/Csv")).toBe(true);
    });

    it("should return false for unsupported file types", () => {
      expect(isSupportedFileMediaType("application/json")).toBe(false);
      expect(isSupportedFileMediaType("application/xml")).toBe(false);
      expect(isSupportedFileMediaType("application/zip")).toBe(false);
    });

    it("should return false for image types", () => {
      expect(isSupportedFileMediaType("image/png")).toBe(false);
      expect(isSupportedFileMediaType("image/jpeg")).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(isSupportedFileMediaType("")).toBe(false);
    });
  });

  describe("isSupportedImageMediaType", () => {
    it("should return true for supported image formats", () => {
      expect(isSupportedImageMediaType("image/png")).toBe(true);
      expect(isSupportedImageMediaType("image/jpeg")).toBe(true);
      expect(isSupportedImageMediaType("image/jpg")).toBe(true);
      expect(isSupportedImageMediaType("image/webp")).toBe(true);
      expect(isSupportedImageMediaType("image/gif")).toBe(true);
    });

    it("should handle uppercase image types", () => {
      expect(isSupportedImageMediaType("IMAGE/PNG")).toBe(true);
      expect(isSupportedImageMediaType("IMAGE/JPEG")).toBe(true);
    });

    it("should return false for unsupported image types", () => {
      expect(isSupportedImageMediaType("image/svg+xml")).toBe(false);
      expect(isSupportedImageMediaType("image/bmp")).toBe(false);
    });

    it("should return false for non-image types", () => {
      expect(isSupportedImageMediaType("application/pdf")).toBe(false);
      expect(isSupportedImageMediaType("text/csv")).toBe(false);
    });
  });
});
