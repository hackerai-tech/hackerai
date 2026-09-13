import {
  redactSensitiveErrorMessage,
  stringifyRedactedError,
  stripControlSequencesFromErrorMessage,
} from "../error-redaction";

describe("error redaction", () => {
  it("redacts service keys from Convex validation messages", () => {
    const message =
      'ArgumentValidationError: Object is missing the required field `userId`.\n\nObject: {fileIds: ["file1"], serviceKey: "secret-value"}';

    expect(redactSensitiveErrorMessage(message)).toContain(
      'serviceKey: "[Redacted]"',
    );
    expect(redactSensitiveErrorMessage(message)).not.toContain("secret-value");
  });

  it("redacts sensitive fields from non-Error values", () => {
    const redacted = stringifyRedactedError({
      message: "failed",
      service_key: "service-secret",
      token: "token-secret",
    });

    expect(redacted).toContain('service_key":"[Redacted]"');
    expect(redacted).toContain('token":"[Redacted]"');
    expect(redacted).not.toContain("service-secret");
    expect(redacted).not.toContain("token-secret");
  });

  it("redacts known secret environment variable assignments", () => {
    const message =
      "Failed with CONVEX_SERVICE_ROLE_KEY=super-secret and STRIPE_SECRET_KEY='stripe-secret'";

    const redacted = redactSensitiveErrorMessage(message);

    expect(redacted).toContain('CONVEX_SERVICE_ROLE_KEY="[Redacted]"');
    expect(redacted).toContain('STRIPE_SECRET_KEY="[Redacted]"');
    expect(redacted).not.toContain("super-secret");
    expect(redacted).not.toContain("stripe-secret");
  });

  it("strips ANSI escapes and control bytes before redacting secrets", () => {
    const esc = String.fromCharCode(0x1b);
    const bell = String.fromCharCode(0x07);
    const message = `${esc}[31mtoken=secret-value${bell}`;

    expect(stripControlSequencesFromErrorMessage(message)).toBe(
      "token=secret-value",
    );

    const redacted = redactSensitiveErrorMessage(message);
    expect(redacted).toBe('token="[Redacted]"');
    expect(redacted).not.toContain(esc);
    expect(redacted).not.toContain(bell);
    expect(redacted).not.toContain("secret-value");
  });

  it("redacts complete presigned URLs including storage object paths", () => {
    const signedUrl =
      "https://bucket.s3.amazonaws.com/user-files/user_123/private-image.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key&X-Amz-Signature=signature-secret";
    const message = `Provider failed to download ${signedUrl} with HTTP 404`;

    const redacted = redactSensitiveErrorMessage(message);

    expect(redacted).toBe(
      "Provider failed to download [Redacted signed URL] with HTTP 404",
    );
    expect(redacted).not.toContain("user-files");
    expect(redacted).not.toContain("access-key");
    expect(redacted).not.toContain("signature-secret");
  });

  it("preserves ordinary non-signed diagnostic URLs", () => {
    const message =
      "Provider request failed at https://openrouter.ai/api/v1/chat/completions";

    expect(redactSensitiveErrorMessage(message)).toBe(message);
  });

  it("redacts signed URLs with apostrophes in object paths", () => {
    const message =
      "Provider failed for 'https://bucket.s3.amazonaws.com/user-files/user's-file.png?X-Amz-Credential=access-key&X-Amz-Signature=signature-secret'";

    const redacted = redactSensitiveErrorMessage(message);

    expect(redacted).toBe("Provider failed for '[Redacted signed URL]'");
    expect(redacted).not.toContain("user's-file");
    expect(redacted).not.toContain("access-key");
    expect(redacted).not.toContain("signature-secret");
  });
});
