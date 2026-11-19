import { getUserIDAndPro } from "../get-user-id";
import { ChatSDKError } from "@/lib/errors";
import { createFreeQuotaSubject } from "../free-quota-subject";

const authkit = jest.fn();
jest.mock("@workos-inc/authkit-nextjs", () => ({
  authkit: (...args: unknown[]) => authkit(...args),
}));

it.each([
  ["practitioner@example.org", "non_internal"],
  ["staff@HACKERAI.COM", "internal"],
  ["staff@hackerai.co", "internal"],
  ["staff@hackerai.com.example.org", "non_internal"],
  [undefined, "unknown"],
  ["invalid", "unknown"],
])(
  "classifies authenticated account metadata without returning the email (%s)",
  async (email, cohort) => {
    authkit.mockResolvedValue({
      session: {
        user: { id: "synthetic", email, emailVerified: true },
        entitlements: [],
      },
    });
    const result = await getUserIDAndPro({} as never);
    expect(result.analyticsAccountCohort).toBe(cohort);
    expect(result).not.toHaveProperty("email");
    expect(JSON.stringify(result)).not.toContain(email ?? "no-email-marker");
  },
);

it("does not classify a missing authenticated user", async () => {
  authkit.mockResolvedValue({ session: null });
  await expect(getUserIDAndPro({} as never)).rejects.toMatchObject({
    type: "unauthorized",
  });
});

describe("future Gmail quota identity from authenticated account metadata", () => {
  const originalCutoff = process.env.FREE_QUOTA_GMAIL_NEW_USERS_FROM;
  const originalSecret = process.env.ACCOUNT_IDENTITY_HMAC_SECRET;
  beforeEach(() => {
    process.env.FREE_QUOTA_GMAIL_NEW_USERS_FROM = "2027-01-01T00:00:00.000Z";
    process.env.ACCOUNT_IDENTITY_HMAC_SECRET = "synthetic-quota-secret";
  });
  afterEach(() => {
    if (originalCutoff === undefined)
      delete process.env.FREE_QUOTA_GMAIL_NEW_USERS_FROM;
    else process.env.FREE_QUOTA_GMAIL_NEW_USERS_FROM = originalCutoff;
    if (originalSecret === undefined)
      delete process.env.ACCOUNT_IDENTITY_HMAC_SECRET;
    else process.env.ACCOUNT_IDENTITY_HMAC_SECRET = originalSecret;
  });

  it("shares future usage while retaining exact account identity and ignores request creation time", async () => {
    const results = [];
    for (const email of ["first@gmail.com", "f.irst+two@googlemail.com"]) {
      authkit.mockResolvedValueOnce({
        session: {
          user: {
            id: "synthetic",
            email,
            emailVerified: true,
            createdAt: "2027-01-01T00:00:00.000Z",
          },
          entitlements: [],
        },
      });
      const result = await getUserIDAndPro({
        createdAt: "2020-01-01T00:00:00Z",
      } as never);
      expect(result.freeQuotaSubject).toBe(createFreeQuotaSubject(email));
      expect(result.freeUsageQuotaSubject).toMatch(/^free_quota:v2:/);
      results.push(result);
    }
    expect(results[0].freeUsageQuotaSubject).toBe(
      results[1].freeUsageQuotaSubject,
    );
    expect(results[0].freeQuotaSubject).not.toBe(results[1].freeQuotaSubject);
  });

  it("retains old free quotas and does not select shared free quotas for paid users", async () => {
    for (const [createdAt, entitlements] of [
      ["2026-12-31T23:59:59.999Z", []],
      ["2027-01-01T00:00:00.000Z", ["pro-plan"]],
    ] as const) {
      const email = "f.irst+one@gmail.com";
      authkit.mockResolvedValueOnce({
        session: {
          user: { id: "synthetic", email, emailVerified: true, createdAt },
          entitlements,
        },
      });
      const result = await getUserIDAndPro({} as never);
      expect(result.freeQuotaSubject).toBe(createFreeQuotaSubject(email));
      expect(result.freeUsageQuotaSubject).toBe(
        entitlements.length ? undefined : result.freeQuotaSubject,
      );
    }
  });
});

describe("authentication phase observer", () => {
  beforeEach(() => authkit.mockReset());

  it("keeps session work pending until it resolves and emits no session values", async () => {
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    authkit.mockImplementationOnce(() => {
      started();
      return pending;
    });
    const phases: unknown[] = [];
    const req = {} as never;
    const result = getUserIDAndPro(req, (phase) => phases.push(phase));
    await entered;
    expect(phases).toEqual(["load_sdk", "session"]);
    expect(authkit).toHaveBeenCalledWith(req);
    finish({
      session: {
        user: {
          id: "synthetic",
          email: "PRIVATE@example.org",
          emailVerified: true,
        },
        entitlements: [],
        organizationId: "synthetic-org",
        accessToken: "PRIVATE token",
      },
    });
    await expect(result).resolves.toMatchObject({
      userId: "synthetic",
      subscription: "free",
      emailVerified: true,
      organizationId: "synthetic-org",
    });
    expect(phases).toEqual(["load_sdk", "session", "entitlements"]);
    expect(JSON.stringify(phases)).not.toContain("PRIVATE");
  });

  it("preserves authenticated results when every observer call throws", async () => {
    authkit.mockResolvedValueOnce({
      session: {
        user: { id: "synthetic", emailVerified: true },
        entitlements: [],
      },
    });
    const observer = jest.fn(() => {
      throw new Error("PRIVATE observer");
    });
    await expect(getUserIDAndPro({} as never, observer)).resolves.toMatchObject(
      { userId: "synthetic", subscription: "free", emailVerified: true },
    );
    expect(authkit).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledTimes(3);
  });

  it("preserves the original authentication error when the observer throws", async () => {
    const error = new ChatSDKError("unauthorized:auth");
    authkit.mockRejectedValueOnce(error);
    const observer = jest.fn(() => {
      throw new Error("PRIVATE observer");
    });
    await expect(getUserIDAndPro({} as never, observer)).rejects.toBe(error);
    expect(authkit).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledTimes(2);
  });
});
