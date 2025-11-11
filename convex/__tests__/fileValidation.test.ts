/**
 * Tests for File Validation
 *
 * @module convex/__tests__/fileValidation.test.ts
 */

import { describe, it, expect } from "@jest/globals";
import {
  validateFile,
  validateFileName,
  validateFileSize,
  isAllowedMimeType,
  verifyFileSignature,
  getFileTypeName,
} from "../fileValidation";

describe("fileValidation", () => {
  describe("validateFileName", () => {
    it("should accept valid file names", () => {
      expect(validateFileName("test.pdf")).toBeNull();
      expect(validateFileName("my-file_123.jpg")).toBeNull();
      expect(validateFileName("document.docx")).toBeNull();
    });

    it("should reject empty file names", () => {
      expect(validateFileName("")).toBe("File name cannot be empty");
      expect(validateFileName("   ")).toBe("File name cannot be empty");
    });

    it("should reject file names with path traversal", () => {
      expect(validateFileName("../../../etc/passwd")).toBe(
        "File name contains invalid characters",
      );
      expect(validateFileName("folder/file.pdf")).toBe(
        "File name contains invalid characters",
      );
      expect(validateFileName("folder\\file.pdf")).toBe(
        "File name contains invalid characters",
      );
    });

    it("should reject file names longer than 255 characters", () => {
      const longName = "a".repeat(256) + ".pdf";
      expect(validateFileName(longName)).toBe(
        "File name is too long (max 255 characters)",
      );
    });

    it("should reject non-string values", () => {
      expect(validateFileName(null as any)).toBe("File name is required");
      expect(validateFileName(undefined as any)).toBe("File name is required");
    });
  });

  describe("validateFileSize", () => {
    const MB = 1024 * 1024;

    it("should accept valid file sizes", () => {
      expect(validateFileSize(1 * MB)).toBeNull(); // 1 MB
      expect(validateFileSize(10 * MB)).toBeNull(); // 10 MB
      expect(validateFileSize(19 * MB)).toBeNull(); // 19 MB
      expect(validateFileSize(20 * MB)).toBeNull(); // 20 MB exactly
    });

    it("should reject files larger than max size", () => {
      const error = validateFileSize(21 * MB);
      expect(error).toContain("exceeds maximum allowed size");
      expect(error).toContain("21.00MB");
    });

    it("should reject zero or negative sizes", () => {
      expect(validateFileSize(0)).toBe("File size must be greater than 0");
      expect(validateFileSize(-1)).toBe("File size must be greater than 0");
    });

    it("should respect custom max size", () => {
      const customMax = 5 * MB;
      expect(validateFileSize(4 * MB, customMax)).toBeNull();
      expect(validateFileSize(6 * MB, customMax)).toContain(
        "exceeds maximum allowed size",
      );
    });
  });

  describe("isAllowedMimeType", () => {
    it("should allow common image types", () => {
      expect(isAllowedMimeType("image/png")).toBe(true);
      expect(isAllowedMimeType("image/jpeg")).toBe(true);
      expect(isAllowedMimeType("image/gif")).toBe(true);
      expect(isAllowedMimeType("image/webp")).toBe(true);
    });

    it("should allow common document types", () => {
      expect(isAllowedMimeType("application/pdf")).toBe(true);
      expect(isAllowedMimeType("text/plain")).toBe(true);
      expect(isAllowedMimeType("text/csv")).toBe(true);
      expect(isAllowedMimeType("application/json")).toBe(true);
    });

    it("should allow Office document types", () => {
      expect(
        isAllowedMimeType(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
      ).toBe(true);
      expect(
        isAllowedMimeType(
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
      ).toBe(true);
    });

    it("should reject disallowed MIME types", () => {
      expect(isAllowedMimeType("application/x-executable")).toBe(false);
      expect(isAllowedMimeType("application/x-msdownload")).toBe(false);
      expect(isAllowedMimeType("video/mp4")).toBe(false);
    });

    it("should handle MIME types with parameters", () => {
      expect(isAllowedMimeType("text/plain; charset=utf-8")).toBe(true);
      expect(isAllowedMimeType("application/json; charset=utf-8")).toBe(true);
    });

    it("should be case insensitive", () => {
      expect(isAllowedMimeType("IMAGE/PNG")).toBe(true);
      expect(isAllowedMimeType("Image/Jpeg")).toBe(true);
    });
  });

  describe("verifyFileSignature", () => {
    it("should verify PNG signature", () => {
      const pngSignature = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      expect(verifyFileSignature(pngSignature, "image/png")).toBe(true);
    });

    it("should verify JPEG signature", () => {
      const jpegSignature = Buffer.from([0xff, 0xd8, 0xff]);
      expect(verifyFileSignature(jpegSignature, "image/jpeg")).toBe(true);
    });

    it("should verify PDF signature", () => {
      const pdfSignature = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
      expect(verifyFileSignature(pdfSignature, "application/pdf")).toBe(true);
    });

    it("should reject incorrect signatures", () => {
      const wrongSignature = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      expect(verifyFileSignature(wrongSignature, "image/png")).toBe(false);
      expect(verifyFileSignature(wrongSignature, "application/pdf")).toBe(false);
    });

    it("should allow text files without signature check", () => {
      const textContent = Buffer.from("Hello, World!");
      expect(verifyFileSignature(textContent, "text/plain")).toBe(true);
      expect(verifyFileSignature(textContent, "text/csv")).toBe(true);
      expect(verifyFileSignature(textContent, "application/json")).toBe(true);
    });

    it("should handle unknown types gracefully", () => {
      const unknownBuffer = Buffer.from([0x00, 0x00]);
      expect(verifyFileSignature(unknownBuffer, "application/unknown")).toBe(
        true,
      );
    });
  });

  describe("validateFile", () => {
    it("should pass validation for valid files", () => {
      const result = validateFile("test.pdf", "application/pdf", 5 * 1024 * 1024);
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should fail validation for invalid file name", () => {
      const result = validateFile("../etc/passwd", "text/plain", 1024);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("invalid characters");
    });

    it("should fail validation for disallowed MIME type", () => {
      const result = validateFile("malware.exe", "application/x-executable", 1024);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("not allowed");
    });

    it("should fail validation for oversized files", () => {
      const result = validateFile(
        "large.pdf",
        "application/pdf",
        21 * 1024 * 1024,
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("exceeds");
    });

    it("should verify file signature when buffer provided", () => {
      const pngSignature = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const result = validateFile(
        "image.png",
        "image/png",
        1024,
        pngSignature,
      );
      expect(result.isValid).toBe(true);
    });

    it("should fail validation for mismatched signature", () => {
      const wrongSignature = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      const result = validateFile(
        "fake.png",
        "image/png",
        1024,
        wrongSignature,
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("does not match declared type");
    });
  });

  describe("getFileTypeName", () => {
    it("should return friendly names for common types", () => {
      expect(getFileTypeName("image/png")).toBe("PNG Image");
      expect(getFileTypeName("image/jpeg")).toBe("JPEG Image");
      expect(getFileTypeName("application/pdf")).toBe("PDF Document");
      expect(getFileTypeName("text/plain")).toBe("Text File");
    });

    it("should return MIME type for unknown types", () => {
      expect(getFileTypeName("application/unknown")).toBe("application/unknown");
    });
  });
});
