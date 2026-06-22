import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

jest.mock("server-only", () => ({}));

describe("free quota subject", () => {
  const originalSecret = process.env.ACCOUNT_IDENTITY_HMAC_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.resetModules();
    process.env.ACCOUNT_IDENTITY_HMAC_SECRET = "test-account-identity-secret";
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.ACCOUNT_IDENTITY_HMAC_SECRET;
    } else {
      process.env.ACCOUNT_IDENTITY_HMAC_SECRET = originalSecret;
    }
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("normalizes email with trim and lowercase only", async () => {
    const { normalizeQuotaEmail } = await import("../free-quota-subject");

    expect(normalizeQuotaEmail("  Person+Alias@Example.COM  ")).toBe(
      "person+alias@example.com",
    );
  });

  it("maps the same normalized email to the same subject", async () => {
    const { createFreeQuotaSubject } = await import("../free-quota-subject");

    expect(createFreeQuotaSubject("User@Example.com")).toBe(
      createFreeQuotaSubject(" user@example.com "),
    );
  });

  it("maps different emails to different subjects", async () => {
    const { createFreeQuotaSubject } = await import("../free-quota-subject");

    expect(createFreeQuotaSubject("one@example.com")).not.toBe(
      createFreeQuotaSubject("two@example.com"),
    );
  });

  it("does not expose the raw email in the subject or redacted log value", async () => {
    const { createFreeQuotaSubject, redactFreeQuotaSubjectForLog } =
      await import("../free-quota-subject");

    const subject = createFreeQuotaSubject("Sensitive@Example.com");
    const redacted = redactFreeQuotaSubjectForLog(subject);

    expect(subject).toBeDefined();
    expect(subject).not.toContain("Sensitive");
    expect(subject).not.toContain("sensitive@example.com");
    expect(redacted).toMatch(/^free_quota:v1:[a-f0-9]{12}$/);
    expect(redacted).not.toBe(subject);
  });

  it("fails closed in production when the HMAC secret is missing", async () => {
    delete process.env.ACCOUNT_IDENTITY_HMAC_SECRET;
    process.env.NODE_ENV = "production";
    const { createFreeQuotaSubject } = await import("../free-quota-subject");

    try {
      createFreeQuotaSubject("user@example.com");
      expect.fail("Expected missing production secret to throw");
    } catch (error) {
      expect(error).toMatchObject({
        type: "forbidden",
        surface: "auth",
        cause: "account_identity_hmac_secret_missing",
      });
    }
  });
});
