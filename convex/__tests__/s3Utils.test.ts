/**
 * Tests for S3 Utilities
 *
 * @module convex/__tests__/s3Utils.test.ts
 */

import { describe, it, expect } from "@jest/globals";
import { generateS3Key } from "../s3Utils";

describe("s3Utils", () => {
  describe("generateS3Key", () => {
    it("should generate a valid S3 key with correct format", () => {
      const userId = "user_123";
      const fileName = "test-file.pdf";

      const key = generateS3Key(userId, fileName);

      // Check format: uploads/{userId}/{timestamp}-{random}-{sanitized}
      expect(key).toMatch(/^uploads\/user_123\/\d+-[a-z0-9]+-test-file\.pdf$/);
    });

    it("should sanitize special characters in file names", () => {
      const userId = "user_123";
      const fileName = "my file (1) @ #$%^&*.pdf";

      const key = generateS3Key(userId, fileName);

      // Special characters should be replaced with underscores
      expect(key).toMatch(/uploads\/user_123\/\d+-[a-z0-9]+-my_file__1________\.pdf$/);
    });

    it("should limit file name length to 100 characters", () => {
      const userId = "user_123";
      const longFileName = "a".repeat(200) + ".pdf";

      const key = generateS3Key(userId, longFileName);

      // Extract just the filename part (after last /)
      const parts = key.split("/");
      const lastPart = parts[parts.length - 1];

      // Remove timestamp and random parts
      const fileNamePart = lastPart.split("-").slice(2).join("-");

      expect(fileNamePart.length).toBeLessThanOrEqual(100);
    });

    it("should throw error for empty userId", () => {
      expect(() => generateS3Key("", "test.pdf")).toThrow(
        "Invalid userId: must be a non-empty string",
      );
    });

    it("should throw error for empty fileName", () => {
      expect(() => generateS3Key("user_123", "")).toThrow(
        "Invalid fileName: must be a non-empty string",
      );
    });

    it("should throw error for non-string userId", () => {
      expect(() => generateS3Key(null as any, "test.pdf")).toThrow(
        "Invalid userId: must be a non-empty string",
      );
    });

    it("should throw error for non-string fileName", () => {
      expect(() => generateS3Key("user_123", null as any)).toThrow(
        "Invalid fileName: must be a non-empty string",
      );
    });

    it("should generate unique keys for the same file", () => {
      const userId = "user_123";
      const fileName = "test.pdf";

      const key1 = generateS3Key(userId, fileName);
      const key2 = generateS3Key(userId, fileName);

      expect(key1).not.toBe(key2); // Different timestamps/random values
    });
  });

  // Note: Other functions (generateS3DownloadUrl, generateS3UploadUrl, etc.)
  // require AWS SDK mocking and would be better tested with integration tests
  // or in a test environment with actual S3 access.
});
