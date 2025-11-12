import "@testing-library/jest-dom";
import { describe, it, expect } from "@jest/globals";
import { isSupportedImageMediaType } from "@/lib/utils/file-utils";

describe("Image URL Cache - File Type Detection", () => {
  it("should identify supported image types correctly", () => {
    expect(isSupportedImageMediaType("image/png")).toBe(true);
    expect(isSupportedImageMediaType("image/jpeg")).toBe(true);
    expect(isSupportedImageMediaType("image/jpg")).toBe(true);
    expect(isSupportedImageMediaType("image/webp")).toBe(true);
    expect(isSupportedImageMediaType("image/gif")).toBe(true);
  });

  it("should reject non-image media types", () => {
    expect(isSupportedImageMediaType("application/pdf")).toBe(false);
    expect(isSupportedImageMediaType("text/plain")).toBe(false);
    expect(isSupportedImageMediaType("video/mp4")).toBe(false);
    expect(isSupportedImageMediaType("application/json")).toBe(false);
  });

  it("should handle case sensitivity", () => {
    expect(isSupportedImageMediaType("IMAGE/PNG")).toBe(true);
    expect(isSupportedImageMediaType("Image/Jpeg")).toBe(true);
  });
});
