import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockContext = jest.fn();
const mockAllowed = jest.fn();
const mockRecover = jest.fn();
jest.mock("@/lib/actions/billing-context", () => ({
  getBillingActionContext: mockContext,
}));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanStartBillingTransaction: mockAllowed,
}));
jest.mock("@/app/api/stripe", () => ({ stripe: { testClient: true } }));
jest.mock("@/lib/billing/canceled-renewal-invoice", () => ({
  recoverCanceledRenewalsForCheckout: mockRecover,
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { info: jest.fn(), error: jest.fn() },
}));

describe("recoverCanceledRenewal", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockContext.mockResolvedValue({
      user: { id: "user_owner" },
      organizationId: "org_owner",
      stripeCustomerId: "cus_owner",
    } as never);
    mockRecover.mockResolvedValue(true as never);
  });
  it("only uses the authenticated billing owner's customer", async () => {
    const { default: recover } = await import("../recover-canceled-renewal");
    await expect(recover()).resolves.toBe(true);
    expect(mockAllowed).toHaveBeenCalledWith("user_owner");
    expect(mockRecover).toHaveBeenCalledWith(expect.anything(), "cus_owner");
  });
  it.each(["authorization", "suspension"])(
    "does not mutate after %s failure",
    async (stage) => {
      (stage === "authorization" ? mockContext : mockAllowed).mockRejectedValue(
        new Error("not allowed") as never,
      );
      const { default: recover } = await import("../recover-canceled-renewal");
      await expect(recover()).rejects.toThrow("not allowed");
      expect(mockRecover).not.toHaveBeenCalled();
    },
  );
});
