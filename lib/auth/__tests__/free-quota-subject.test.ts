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
  const originalCutoff = process.env.FREE_QUOTA_GMAIL_NEW_USERS_FROM;

  beforeEach(() => {
    jest.resetModules();
    process.env.ACCOUNT_IDENTITY_HMAC_SECRET = "test-account-identity-secret";
    process.env.NODE_ENV = "test";
    delete process.env.FREE_QUOTA_GMAIL_NEW_USERS_FROM;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.ACCOUNT_IDENTITY_HMAC_SECRET;
    } else {
      process.env.ACCOUNT_IDENTITY_HMAC_SECRET = originalSecret;
    }
    process.env.NODE_ENV = originalNodeEnv;
    if (originalCutoff === undefined)
      delete process.env.FREE_QUOTA_GMAIL_NEW_USERS_FROM;
    else process.env.FREE_QUOTA_GMAIL_NEW_USERS_FROM = originalCutoff;
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

  it("groups future Gmail aliases in a new namespace and preserves old accounts", async () => {
    process.env.FREE_QUOTA_GMAIL_NEW_USERS_FROM = "2027-01-01T00:00:00.000Z";
    const { createFreeQuotaSubject, createFreeUsageQuotaSubject } =
      await import("../free-quota-subject");
    const before = "2026-12-31T23:59:59.999Z";
    const after = "2027-01-01T00:00:00.000Z";
    const expected = createFreeUsageQuotaSubject("first@gmail.com", after);
    expect(expected).toMatch(/^free_quota:v2:[a-f0-9]{64}$/);
    for (const alias of [
      "first@gmail.com",
      "F.irst+one@gmail.com",
      "fi.rst+two@googlemail.com",
    ]) {
      expect(createFreeUsageQuotaSubject(alias, after)).toBe(expected);
      expect(createFreeUsageQuotaSubject(alias, before)).toBe(
        createFreeQuotaSubject(alias),
      );
      expect(createFreeQuotaSubject(alias)).not.toBe(expected);
    }
    expect(createFreeUsageQuotaSubject("second@gmail.com", after)).not.toBe(
      expected,
    );
    expect(
      createFreeUsageQuotaSubject(
        "first@gmail.com",
        "2028-01-01T00:00:00.000Z",
      ),
    ).toBe(expected);
  });

  it("retains exact identities for nonconsumer domains and when rollout is absent", async () => {
    const { createFreeQuotaSubject, createFreeUsageQuotaSubject } =
      await import("../free-quota-subject");
    const email = "f.irst+one@gmail.com";
    expect(createFreeUsageQuotaSubject(email, undefined)).toBe(
      createFreeQuotaSubject(email),
    );
    process.env.FREE_QUOTA_GMAIL_NEW_USERS_FROM = "2027-01-01T00:00:00.000Z";
    for (const other of [
      "f.irst+one@company.com",
      "first@company.com",
      "f.irst+one@gmail.com.example.org",
    ]) {
      expect(createFreeUsageQuotaSubject(other, "2028-01-01T00:00:00Z")).toBe(
        createFreeQuotaSubject(other),
      );
    }
  });

  it.each([undefined, "invalid"])(
    "rejects unknown Gmail account creation time after rollout is configured (%s)",
    async (createdAt) => {
      process.env.FREE_QUOTA_GMAIL_NEW_USERS_FROM = "2027-01-01T00:00:00.000Z";
      const { createFreeUsageQuotaSubject } =
        await import("../free-quota-subject");
      expect(() =>
        createFreeUsageQuotaSubject("first@gmail.com", createdAt),
      ).toThrow();
    },
  );

  it.each(["invalid", "2027-02-30T00:00:00.000Z"])(
    "rejects invalid rollout configuration (%s)",
    async (cutoff) => {
      process.env.FREE_QUOTA_GMAIL_NEW_USERS_FROM = cutoff;
      const { createFreeUsageQuotaSubject } =
        await import("../free-quota-subject");
      expect(() =>
        createFreeUsageQuotaSubject("first@gmail.com", "2028-01-01T00:00:00Z"),
      ).toThrow();
    },
  );

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
