import {
  redactSensitiveErrorMessage,
  stringifyRedactedError,
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
});
