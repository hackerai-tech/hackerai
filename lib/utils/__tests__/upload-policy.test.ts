import { validateUploadPolicy } from "../upload-policy";

describe("upload policy messages", () => {
  it("recommends Agent mode when Ask file uploads exceed the client byte limit", () => {
    const result = validateUploadPolicy({
      mode: "ask",
      size: 11 * 1024 * 1024,
      mediaType: "application/pdf",
      surface: "client",
    });

    expect(result).toEqual({
      valid: false,
      code: "FILE_SIZE_EXCEEDED",
      message:
        "File size must be less than 10MB. Switch to Agent mode to upload larger files for sandbox analysis.",
    });
  });

  it("recommends Agent mode when Ask image uploads exceed the provider image limit", () => {
    const result = validateUploadPolicy({
      mode: "ask",
      size: 6 * 1024 * 1024,
      mediaType: "image/png",
      surface: "client",
    });

    expect(result).toEqual({
      valid: false,
      code: "IMAGE_SIZE_EXCEEDED",
      message:
        "Image size must be less than 5MB. Switch to Agent mode to upload larger files for sandbox analysis.",
    });
  });

  it("does not recommend switching modes when Agent uploads exceed the sandbox cap", () => {
    const result = validateUploadPolicy({
      mode: "agent",
      size: 251 * 1024 * 1024,
      mediaType: "application/zip",
      surface: "client",
    });

    expect(result).toEqual({
      valid: false,
      code: "FILE_SIZE_EXCEEDED",
      message: "File size must be less than 250MB.",
    });
  });
});
