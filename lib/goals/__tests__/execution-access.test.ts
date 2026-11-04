jest.mock("@/lib/db/actions", () => ({
  getCurrentAgentEntitlementContext: jest.fn(),
}));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanMakeCostIncurringRequest: jest.fn(),
}));
jest.mock("@/app/posthog", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/posthog/flag-assignment", () => ({
  getPostHogFlagWithoutExposure: jest.fn(),
}));
import { getCurrentAgentEntitlementContext } from "@/lib/db/actions";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import PostHogClient from "@/app/posthog";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
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
  jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(true);
  jest.mocked(PostHogClient).mockReturnValue({
    shutdown: jest.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof PostHogClient>);
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
  expect(getPostHogFlagWithoutExposure).not.toHaveBeenCalled();
});
test("keeps suspension and feature access gates", async () => {
  jest
    .mocked(assertUserCanMakeCostIncurringRequest)
    .mockRejectedValueOnce(new Error("suspended"));
  await expect(assertGoalExecutionAllowed(payload)).rejects.toThrow(
    "suspended",
  );
  expect(getCurrentAgentEntitlementContext).not.toHaveBeenCalled();
  jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(false);
  await expect(assertGoalExecutionAllowed(payload)).rejects.toThrow();
});
