import { describe, expect, it, jest } from "@jest/globals";

import {
  applySupportConfirmedFraudSuspension,
  buildSupportConfirmedFraudSuspensionPlan,
} from "../support-confirmed-fraud";

const input = {
  chargeId: "ch_123",
  customerId: "cus_123",
  userId: "user_123",
  caseId: "intercom_456",
};

const makeDependencies = () => ({
  retrieveCharge: jest.fn<any>().mockResolvedValue({
    id: "ch_123",
    customer: "cus_123",
    amount: 13_999,
    currency: "usd",
    disputed: false,
    refunded: false,
  }),
  resolveCustomerUsers: jest.fn<any>().mockResolvedValue({
    userIds: ["user_123"],
    orgId: "org_123",
  }),
});

describe("support-confirmed fraud suspension", () => {
  it("builds an auditable support-sourced plan from matching exact IDs", async () => {
    const dependencies = makeDependencies();

    const plan = await buildSupportConfirmedFraudSuspensionPlan(
      input,
      dependencies,
    );

    expect(plan).toEqual({
      category: "support_confirmed_fraud",
      source: "support",
      sourceId: "support_case:intercom_456",
      sourceReason: "confirmed_unauthorized_charge",
      sourceCreatedAt: expect.any(Number),
      userId: "user_123",
      stripeCustomerId: "cus_123",
      stripeChargeId: "ch_123",
      workosOrganizationId: "org_123",
      chargeAmount: 13_999,
      chargeCurrency: "usd",
      chargeDisputed: false,
      chargeRefunded: false,
    });
    expect(dependencies.retrieveCharge).toHaveBeenCalledWith("ch_123");
    expect(dependencies.resolveCustomerUsers).toHaveBeenCalledWith("cus_123");
  });

  it("rejects a charge that belongs to a different Stripe customer", async () => {
    const dependencies = makeDependencies();
    dependencies.retrieveCharge.mockResolvedValueOnce({
      id: "ch_123",
      customer: "cus_other",
      amount: 13_999,
      currency: "usd",
      disputed: false,
      refunded: false,
    });

    await expect(
      buildSupportConfirmedFraudSuspensionPlan(input, dependencies),
    ).rejects.toThrow("does not belong to customer cus_123");
    expect(dependencies.resolveCustomerUsers).not.toHaveBeenCalled();
  });

  it("rejects a user who is not linked to the verified Stripe customer", async () => {
    const dependencies = makeDependencies();
    dependencies.resolveCustomerUsers.mockResolvedValueOnce({
      userIds: ["user_other"],
      orgId: "org_123",
    });

    await expect(
      buildSupportConfirmedFraudSuspensionPlan(input, dependencies),
    ).rejects.toThrow("is not an active member of customer cus_123");
  });

  it("applies only the verified support suspension fields", async () => {
    const dependencies = makeDependencies();
    const plan = await buildSupportConfirmedFraudSuspensionPlan(
      input,
      dependencies,
    );
    const upsertActive = jest.fn<any>().mockResolvedValue("suspension_123");

    await expect(
      applySupportConfirmedFraudSuspension(plan, { upsertActive }),
    ).resolves.toBe("suspension_123");

    expect(upsertActive).toHaveBeenCalledWith({
      category: "support_confirmed_fraud",
      source: "support",
      sourceId: "support_case:intercom_456",
      sourceReason: "confirmed_unauthorized_charge",
      sourceCreatedAt: plan.sourceCreatedAt,
      userId: "user_123",
      stripeCustomerId: "cus_123",
      stripeChargeId: "ch_123",
      workosOrganizationId: "org_123",
    });
  });
});
