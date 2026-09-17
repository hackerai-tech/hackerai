import { enroll, get } from "../paidModelEnrollments";
import { isUserDeletionFenced } from "../lib/userDeletionFence";
jest.mock("../_generated/server", () => ({
  mutation: (x: unknown) => x,
  query: (x: unknown) => x,
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: (key: string) => {
    if (key !== "test") throw Error("Unauthorized");
  },
}));
jest.mock("../lib/userDeletionFence", () => ({
  isUserDeletionFenced: jest.fn(async () => false),
}));
const invoke = (fn: unknown, ctx: unknown, args: unknown) =>
  (fn as { handler: (ctx: unknown, args: unknown) => Promise<any> }).handler(
    ctx,
    args,
  );
const args = {
  serviceKey: "test",
  user_id: "u",
  organization_id: "org",
  variant: "test",
  enrolled_at: 100,
  baseline_renewal_at: 1000,
  stripe_subscription_id: "sub",
  stripe_customer_id: "cus",
  billing_interval: "month",
  billing_interval_count: 1,
  subscription_started_at: 1,
  cancel_at_period_end: true,
  subscription_tier: "pro",
  subscription_status: "active",
};
function setup() {
  let row: Record<string, unknown> | null = null;
  return {
    db: {
      query: () => ({ withIndex: () => ({ unique: async () => row }) }),
      insert: jest.fn(async (_: string, data: Record<string, unknown>) => {
        row = { _id: "e", ...data };
        return "e";
      }),
      get: async () => row,
    },
  };
}
beforeEach(() => jest.mocked(isUserDeletionFenced).mockResolvedValue(false));
it("freezes the first variant and renewal snapshot, including pending cancellation", async () => {
  const ctx = setup();
  const first = await invoke(enroll, ctx, args);
  expect(
    await invoke(enroll, ctx, {
      ...args,
      variant: "control",
      baseline_renewal_at: 5000,
    }),
  ).toEqual(first);
  expect(await invoke(get, ctx, args)).toMatchObject({
    variant: "test",
    baseline_renewal_at: 1000,
    cancel_at_period_end: true,
  });
  expect(ctx.db.insert).toHaveBeenCalledTimes(1);
});
it("rejects unauthenticated service calls", async () => {
  await expect(
    invoke(enroll, setup(), { ...args, serviceKey: "bad" }),
  ).rejects.toThrow("Unauthorized");
  await expect(
    invoke(get, setup(), { ...args, serviceKey: "bad" }),
  ).rejects.toThrow("Unauthorized");
});
it("does not recreate enrollment during account deletion", async () => {
  jest.mocked(isUserDeletionFenced).mockResolvedValue(true);
  const ctx = setup();
  expect(await invoke(enroll, ctx, args)).toBeNull();
  expect(await invoke(get, ctx, args)).toBeNull();
  expect(ctx.db.insert).not.toHaveBeenCalled();
});
it.each([50, NaN, Infinity])(
  "rejects invalid renewal baseline %s",
  async (baseline_renewal_at) => {
    await expect(
      invoke(enroll, setup(), { ...args, baseline_renewal_at }),
    ).rejects.toThrow();
  },
);
