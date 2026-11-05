import { getUserIDAndPro } from "../get-user-id";

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
