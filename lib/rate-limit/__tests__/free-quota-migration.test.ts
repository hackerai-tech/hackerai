import {
  resolveMigratedFreeQuotaSubject,
  FREE_QUOTA_MIGRATION_STATE,
  freeQuotaRedirectKey,
} from "../free-quota-migration";

describe("quota migration gate and compatibility", () => {
  const original = process.env.FREE_QUOTA_GMAIL_CANONICALIZATION;
  afterEach(() => {
    if (original === undefined)
      delete process.env.FREE_QUOTA_GMAIL_CANONICALIZATION;
    else process.env.FREE_QUOTA_GMAIL_CANONICALIZATION = original;
  });
  const source = "free_quota:v1:old";
  const target = "free_quota:v1:canonical";
  const client = (state: string | null) => ({
    get: jest.fn(async (key: string) =>
      key === FREE_QUOTA_MIGRATION_STATE
        ? state
        : key === freeQuotaRedirectKey(source)
          ? target
          : null,
    ),
  });
  it.each([null, "paused", "migrated"])(
    "fails closed before completed migration (%s)",
    async (state) => {
      process.env.FREE_QUOTA_GMAIL_CANONICALIZATION = "true";
      await expect(
        resolveMigratedFreeQuotaSubject(client(state) as any, source),
      ).rejects.toMatchObject({ type: "rate_limit" });
    },
  );
  it("blocks old admissions while allowing final cost settlement during drain", async () => {
    delete process.env.FREE_QUOTA_GMAIL_CANONICALIZATION;
    await expect(
      resolveMigratedFreeQuotaSubject(client("paused") as any, source),
    ).rejects.toMatchObject({ type: "rate_limit" });
    await expect(
      resolveMigratedFreeQuotaSubject(client("paused") as any, source, true),
    ).resolves.toBe(target);
  });
  it("forwards old durable payloads even when the environment switch is off", async () => {
    delete process.env.FREE_QUOTA_GMAIL_CANONICALIZATION;
    await expect(
      resolveMigratedFreeQuotaSubject(client("complete") as any, source),
    ).resolves.toBe(target);
  });
  it("preserves unrelated identities", async () => {
    process.env.FREE_QUOTA_GMAIL_CANONICALIZATION = "true";
    await expect(
      resolveMigratedFreeQuotaSubject(
        client("complete") as any,
        "free_quota:v1:unrelated",
      ),
    ).resolves.toBe("free_quota:v1:unrelated");
  });
});
