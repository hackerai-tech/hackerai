import { getEarlyRenewalNotice } from "../early-renewal-notice";
import type { SubscriptionCancellationStatus } from "../api-types";

const failedRenewal: SubscriptionCancellationStatus = {
  hasActiveSubscription: true,
  cancelAtPeriodEnd: false,
  subscriptionStatus: "past_due",
  renewalPaymentRequired: true,
  renewalInvoicePayable: true,
  latestInvoiceId: "in_synthetic",
  stripePriceLookupKey: "pro-plus-yearly-plan",
};

describe("getEarlyRenewalNotice", () => {
  it.each([
    ["pro-monthly-plan", "Pro"],
    ["pro-plus-yearly-plan", "Pro+"],
    ["ultra-monthly-plan", "Ultra"],
    // Reaches the client only after the server verified an admin or owner.
    ["team-monthly-plan", "Team"],
  ])("names the live %s plan", (stripePriceLookupKey, planName) => {
    expect(
      getEarlyRenewalNotice({ ...failedRenewal, stripePriceLookupKey }),
    ).toEqual(expect.objectContaining({ planName, invoiceId: "in_synthetic" }));
  });

  it("accepts an unpaid subscription with an open renewal", () => {
    expect(
      getEarlyRenewalNotice({ ...failedRenewal, subscriptionStatus: "unpaid" }),
    ).not.toBeNull();
  });

  it.each<[string, SubscriptionCancellationStatus | undefined]>([
    ["unknown status", undefined],
    [
      "no current subscription",
      { ...failedRenewal, hasActiveSubscription: false },
    ],
    ["active subscription", { ...failedRenewal, subscriptionStatus: "active" }],
    ["missing status", { ...failedRenewal, subscriptionStatus: undefined }],
    [
      "no open renewal",
      { ...failedRenewal, renewalPaymentRequired: undefined },
    ],
    ["unpayable invoice", { ...failedRenewal, renewalInvoicePayable: false }],
    ["paid renewal", { ...failedRenewal, renewalInvoicePaid: true }],
    ["canceled review", { ...failedRenewal, checkoutRequiresReview: true }],
    [
      "unverifiable history",
      { ...failedRenewal, billingReviewUnavailable: true },
    ],
    ["scheduled cancel", { ...failedRenewal, cancelAtPeriodEnd: true }],
    [
      "scheduled pause",
      { ...failedRenewal, pause: { months: 1, resumeAt: 1_800_000_000_000 } },
    ],
    ["missing invoice", { ...failedRenewal, latestInvoiceId: undefined }],
    [
      "unrecognized plan",
      { ...failedRenewal, stripePriceLookupKey: undefined },
    ],
  ])("returns no notice for %s", (_, status) => {
    expect(getEarlyRenewalNotice(status)).toBeNull();
  });
});
