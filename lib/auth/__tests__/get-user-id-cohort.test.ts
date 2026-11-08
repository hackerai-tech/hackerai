import { getUserIDAndPro } from "../get-user-id";
import { ChatSDKError } from "@/lib/errors";

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
