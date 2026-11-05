import {
  redactSensitiveErrorMessage,
  stringifyRedactedError,
  stripControlSequencesFromErrorMessage,
} from "../error-redaction";

describe("error redaction", () => {
  it.each([
    "sk-proj-SYNTHETIC_provider_key_with-underscores_012345",
    "sk-ant-api03-SYNTHETIC_provider_key_with-underscores_012345",
    "sk-or-v1-SYNTHETIC_provider_key_with-underscores_012345",
  ])("redacts a standalone provider key: %s", (key) => {
    const message = `Provider rejected '${key}'; status 401, request req_123.`;
    const redacted = redactSensitiveErrorMessage(message);
    expect(redacted).toBe(
      "Provider rejected '[Redacted]'; status 401, request req_123.",
    );
    expect(redactSensitiveErrorMessage(redacted)).toBe(redacted);
  });

  it("preserves short labels and embedded non-credential identifiers", () => {
    const message =
      "sk-example task-SYNTHETIC_identifier_012345 mask-SYNTHETIC_identifier_012345 task-sk-SYNTHETIC_identifier_012345";
    expect(redactSensitiveErrorMessage(message)).toBe(message);
  });

  it("redacts a provider key after a serialized newline", () => {
    const message = {
      message: "Provider rejected\nsk-proj-SYNTHETIC_provider_key_012345",
    };
    expect(JSON.parse(stringifyRedactedError(message))).toEqual({
      message: "Provider rejected\n[Redacted]",
    });
  });

  it.each(["\\t", "\\r", "\\u0020", "%22", "%20"])(
    "redacts a provider key after an encoded separator %s",
    (separator) => {
      const message = `detail=${separator}sk-proj-SYNTHETIC_provider_key_012345`;
      expect(redactSensitiveErrorMessage(message)).toBe(
        `detail=${separator}[Redacted]`,
      );
    },
  );

  it.each(["\b", "\f"])(
    "redacts keys after raw and serialized control separator %j",
    (separator) => {
      const message = `Provider rejected${separator}sk-proj-SYNTHETIC_provider_key_012345`;
      for (const error of [new Error(message), { message }]) {
        const redacted = stringifyRedactedError(error);
        expect(redacted).not.toContain("SYNTHETIC_provider_key");
        expect(redacted).toContain("[Redacted]");
      }
    },
  );

  it("retains a key boundary while removing ANSI inside and before the key", () => {
    const esc = String.fromCharCode(27);
    for (const key of [
      "sk-proj-SYNTHETIC_provider_key_012345",
      `sk-proj-SYNTHETIC_${esc}[1mprovider_key_012345`,
    ]) {
      const redacted = redactSensitiveErrorMessage(
        `Provider rejected${esc}[31m${key}${esc}[0m; status 401`,
      );
      expect(redacted).not.toContain("SYNTHETIC");
      expect(redacted).not.toContain("provider_key");
      expect(redacted).not.toContain(esc);
      expect(redacted).toContain("[Redacted]");
      expect(redacted).toContain("status 401");
    }
  });

  it("does not split one credential at a control sequence before an interior sk prefix", () => {
    const esc = String.fromCharCode(27);
    const redacted = redactSensitiveErrorMessage(
      `rejected sk-proj-abc${esc}[1msk-123456789012345; status 401`,
    );
    expect(redacted).toBe("rejected [Redacted]; status 401");
  });

  it("does not count control sequences toward the minimum key length", () => {
    const esc = String.fromCharCode(27);
    expect(
      redactSensitiveErrorMessage(`sk-short${`${esc}[0m`.repeat(30)}`),
    ).toBe("sk-short");
  });

  it("redacts ANSI-decorated string values before serializing diagnostics", () => {
    const esc = String.fromCharCode(27);
    const redacted = stringifyRedactedError({
      nested: [
        `rejected${esc}[31msk-abcdefghijklmnopqrst${esc}[0m`,
        `sk-proj-abc${esc}[1msk-123456789012345`,
      ],
      status: 401,
    });
    expect(JSON.parse(redacted)).toEqual({
      nested: ["rejected[Redacted]", "[Redacted]"],
      status: 401,
    });
  });

  it.each([
    "access_token=FAKE_CREDENTIAL",
    "client_secret: FAKE_CREDENTIAL",
    "refreshToken=FAKE_CREDENTIAL",
    "X-Auth-Token: FAKE_CREDENTIAL",
    "x-api-key: FAKE_CREDENTIAL",
    "convex_service_role_key=FAKE_CREDENTIAL",
    "Convex_Service_Role_Key=FAKE_CREDENTIAL",
    "serviceRoleKey=FAKE_CREDENTIAL",
    "stripe_secret_key=FAKE_CREDENTIAL",
    "Stripe_Secret_Key=FAKE_CREDENTIAL",
    "posthog_api_key=FAKE_CREDENTIAL",
    '{"clientSecret":"FAKE_CREDENTIAL"}',
    "Authorization: Bearer FAKE_CREDENTIAL",
    "authorization=Basic FAKE_CREDENTIAL",
    "Provider rejected Bearer FAKE_CREDENTIAL",
    "Provider rejected Bearer prefix=FAKE_CREDENTIAL",
    'token="prefix\\"FAKE_CREDENTIAL"',
    "password='prefix\\'FAKE_CREDENTIAL'",
    'CLIENT_SECRET="prefix\\"FAKE_CREDENTIAL"',
    'access_token="FAKE_CREDENTIAL',
    "https://example.test/error?access_token=FAKE_CREDENTIAL&status=401",
    "token:\nFAKE_CREDENTIAL",
    "serviceKey\n=FAKE_CREDENTIAL",
    "TOKEN_KEY:\nFAKE_CREDENTIAL",
    "password=prefix&FAKE_CREDENTIAL",
    "password=prefix'FAKE_CREDENTIAL",
    "password=prefix]FAKE_CREDENTIAL",
    "Cookie: session=first;refresh=FAKE_CREDENTIAL",
    JSON.stringify({ message: 'token="prefix FAKE_CREDENTIAL"' }),
  ])("redacts credentials in %s", (message) => {
    const redacted = redactSensitiveErrorMessage(message);
    expect(redacted).not.toContain("FAKE_CREDENTIAL");
    expect(redacted).toContain("[Redacted]");
    expect(redactSensitiveErrorMessage(redacted)).toBe(redacted);
  });

  it("preserves retry classification, correlation and usage diagnostics", () => {
    const diagnostic =
      "HTTP 503 WorkerOverloaded ECONNRESET Request ID: req_123 max_tokens=4096 tokenCount=42 secretLength=12 retry_after=2 https://example.test/status";
    expect(redactSensitiveErrorMessage(diagnostic)).toBe(diagnostic);
  });

  it("redacts nested serialized credentials without losing safe fields", () => {
    const value = {
      status: 401,
      nested: {
        client_secret: 'prefix"FAKE_CREDENTIAL',
        refreshToken: "FAKE_REFRESH",
      },
    };
    const redacted = stringifyRedactedError(value);
    expect(JSON.parse(redacted)).toEqual({
      status: 401,
      nested: { client_secret: "[Redacted]", refreshToken: "[Redacted]" },
    });
  });

  it("handles long diagnostic text and credential values", () => {
    const prefix = "x".repeat(100_000);
    const message = `${prefix} access_token="${"s".repeat(100_000)}" status=401`;
    expect(redactSensitiveErrorMessage(message)).toBe(
      `${prefix} access_token="[Redacted]" status=401`,
    );
  });

  it.each([
    undefined,
    () => "private-function-body",
    Symbol("private-symbol"),
    { toJSON: () => undefined },
  ])("formats values without a JSON representation safely", (value) => {
    expect(stringifyRedactedError(value)).toBe("Unknown error occurred");
  });

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

  it("redacts environment assignments for any provider and configuration", () => {
    const message =
      'TRIGGER_SECRET_KEY="trigger-fixture" REDIS_URL=redis://fixture NODE_ENV=production {"WORKOS_COOKIE_PASSWORD":"cookie-fixture"}';
    const redacted = redactSensitiveErrorMessage(message);
    for (const value of [
      "trigger-fixture",
      "redis://fixture",
      "production",
      "cookie-fixture",
    ]) {
      expect(redacted).not.toContain(value);
    }
    expect(redacted).toContain('NODE_ENV="[Redacted]"');
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
