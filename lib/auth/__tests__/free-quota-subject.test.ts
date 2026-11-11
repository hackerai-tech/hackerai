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
  const originalCanonicalization =
    process.env.FREE_QUOTA_GMAIL_CANONICALIZATION;

  beforeEach(() => {
    jest.resetModules();
    process.env.ACCOUNT_IDENTITY_HMAC_SECRET = "test-account-identity-secret";
    process.env.NODE_ENV = "test";
    delete process.env.FREE_QUOTA_GMAIL_CANONICALIZATION;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.ACCOUNT_IDENTITY_HMAC_SECRET;
    } else {
      process.env.ACCOUNT_IDENTITY_HMAC_SECRET = originalSecret;
    }
    process.env.NODE_ENV = originalNodeEnv;
    if (originalCanonicalization === undefined)
      delete process.env.FREE_QUOTA_GMAIL_CANONICALIZATION;
    else
      process.env.FREE_QUOTA_GMAIL_CANONICALIZATION = originalCanonicalization;
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

  it("preserves separate historical quota identities for Gmail aliases", async () => {
    const { createFreeQuotaSubject } = await import("../free-quota-subject");
    expect(createFreeQuotaSubject("f.irst+one@gmail.com")).not.toBe(
      createFreeQuotaSubject("first@gmail.com"),
    );
    expect(createFreeQuotaSubject("first@googlemail.com")).not.toBe(
      createFreeQuotaSubject("first@gmail.com"),
    );
  });

  it("shares only consumer Gmail usage after cutover without changing persisted account identity", async () => {
    process.env.FREE_QUOTA_GMAIL_CANONICALIZATION = "true";
    const { createFreeQuotaSubject, createFreeUsageQuotaSubject } =
      await import("../free-quota-subject");
    const base = createFreeUsageQuotaSubject("first@gmail.com");
    for (const alias of [
      "f.irst@gmail.com",
      "FIRST+one@gmail.com",
      "fi.rst+two@googlemail.com",
    ]) {
      expect(createFreeUsageQuotaSubject(alias)).toBe(base);
      expect(createFreeQuotaSubject(alias)).not.toBe(base);
    }
    expect(createFreeUsageQuotaSubject("first+one@company.com")).not.toBe(
      createFreeUsageQuotaSubject("first@company.com"),
    );
    expect(createFreeUsageQuotaSubject("f.irst@company.com")).not.toBe(
      createFreeUsageQuotaSubject("first@company.com"),
    );
    expect(createFreeUsageQuotaSubject("second@gmail.com")).not.toBe(base);
  });

  it("keeps historical usage selection until the guarded cutover is enabled", async () => {
    const { createFreeQuotaSubject, createFreeUsageQuotaSubject } =
      await import("../free-quota-subject");
    expect(createFreeUsageQuotaSubject("f.irst+one@gmail.com")).toBe(
      createFreeQuotaSubject("f.irst+one@gmail.com"),
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
      });
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    }
  });
});
