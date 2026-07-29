import { logger } from "../logger";

describe("logger error redaction", () => {
  it("redacts presigned URLs from runtime error messages and stacks", () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const signedUrl =
      "https://bucket.s3.amazonaws.com/user-files/user_123/private-image.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key&X-Amz-Signature=signature-secret";
    const error = new Error(`Provider could not fetch ${signedUrl}`);

    logger.error("Provider request failed", error, {
      event: "provider_request_failed",
    });

    const serialized = String(consoleError.mock.calls[0]?.[0]);

    expect(serialized).toContain("[Redacted signed URL]");
    expect(serialized).not.toContain("user-files");
    expect(serialized).not.toContain("access-key");
    expect(serialized).not.toContain("signature-secret");

    consoleError.mockRestore();
  });
});
