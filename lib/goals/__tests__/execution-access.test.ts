jest.mock("@/lib/db/actions", () => ({
  getCurrentAgentEntitlementContext: jest.fn(),
}));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanMakeCostIncurringRequest: jest.fn(),
}));
jest.mock("@/app/posthog", () => ({ __esModule: true, default: jest.fn() }));
import { getCurrentAgentEntitlementContext } from "@/lib/db/actions";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import PostHogClient from "@/app/posthog";
import { assertGoalExecutionAllowed } from "../server";

const payload = {
  userId: "owner",
  chatId: "chat",
  organizationId: "org",
  subscription: "pro" as const,
};
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(getCurrentAgentEntitlementContext).mockResolvedValue({
    subscription: "pro",
    organizationId: "org",
  });
  jest.mocked(PostHogClient).mockReturnValue(null);
});
test("rechecks goal access through the owning deployment entitlement action", async () => {
  await expect(assertGoalExecutionAllowed(payload)).resolves.toBeUndefined();
  expect(getCurrentAgentEntitlementContext).toHaveBeenCalledWith({
    userId: "owner",
    organizationId: "org",
  });
});
test.each([
  { subscription: "free" as const, organizationId: "org" },
  { subscription: "pro" as const, organizationId: "other" },
])("rejects changed billing or organization context: %j", async (context) => {
  jest.mocked(getCurrentAgentEntitlementContext).mockResolvedValue(context);
  await expect(assertGoalExecutionAllowed(payload)).rejects.toThrow();
});
test("fails closed when the entitlement action fails", async () => {
  jest
    .mocked(getCurrentAgentEntitlementContext)
    .mockRejectedValue(new Error("unavailable"));
  await expect(assertGoalExecutionAllowed(payload)).rejects.toThrow(
    "unavailable",
  );
  expect(PostHogClient).not.toHaveBeenCalled();
});
test("keeps suspension ahead of goal entitlement reads", async () => {
  jest
    .mocked(assertUserCanMakeCostIncurringRequest)
    .mockRejectedValueOnce(new Error("suspended"));
  await expect(assertGoalExecutionAllowed(payload)).rejects.toThrow(
    "suspended",
  );
  expect(getCurrentAgentEntitlementContext).not.toHaveBeenCalled();
});

// The rollout is permanent: telemetry availability cannot block paid work.
test.each(["pro", "pro-plus", "ultra", "team"] as const)(
  "allows %s goals without a PostHog client",
  async (subscription) => {
    jest
      .mocked(getCurrentAgentEntitlementContext)
      .mockResolvedValue({ subscription, organizationId: "org" });
    await expect(
      assertGoalExecutionAllowed({ ...payload, subscription }),
    ).resolves.toBeUndefined();
    expect(PostHogClient).not.toHaveBeenCalled();
  },
);
test("allows paid continuation when analytics initialization would throw", async () => {
  jest.mocked(PostHogClient).mockImplementation(() => {
    throw new Error("analytics unavailable");
  });
  await expect(assertGoalExecutionAllowed(payload)).resolves.toBeUndefined();
  expect(PostHogClient).not.toHaveBeenCalled();
});
test("rejects a free run even when its submitted entitlement matches", async () => {
  jest
    .mocked(getCurrentAgentEntitlementContext)
    .mockResolvedValue({ subscription: "free", organizationId: "org" });
  await expect(
    assertGoalExecutionAllowed({ ...payload, subscription: "free" }),
  ).rejects.toThrow();
});
