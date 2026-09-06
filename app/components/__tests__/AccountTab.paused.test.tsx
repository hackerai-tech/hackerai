import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetMockConvexQueries, setMockQueryResult } from "convex/react";

const mockResumeSubscription = jest.fn();
const mockReloadWithEntitlementRefresh = jest.fn();
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();

jest.mock("@/lib/auth/entitlement-refresh-navigation", () => ({
  reloadWithEntitlementRefresh: mockReloadWithEntitlementRefresh,
}));

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: "free",
    setMigrateFromPentestgptDialogOpen: jest.fn(),
  }),
}));

jest.mock("@/app/hooks/usePentestgptMigration", () => ({
  usePentestgptMigration: () => ({ isMigrating: false }),
}));

jest.mock("@/app/hooks/usePricingDialog", () => ({
  redirectToPricing: jest.fn(),
}));

jest.mock("@/lib/billing/client", () => ({
  getSubscriptionCancellationStatus: jest.fn(),
  keepSubscription: jest.fn(),
  redirectToBillingPortal: jest.fn(),
  resumeSubscription: mockResumeSubscription,
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));

jest.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

jest.mock("../DeleteAccountDialog", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("../CancelSubscriptionDialog", () => ({
  __esModule: true,
  default: () => null,
}));

const AccountTab = require("../AccountTab")
  .AccountTab as typeof import("../AccountTab").AccountTab;

const RESUME_AT = Date.UTC(2026, 11, 1, 12);

function pausedRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "pause_1",
    userId: "user_1",
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_old",
    stripePriceId: "price_pro_plus",
    stripePriceLookupKey: "pro-plus-monthly-plan",
    subscriptionTier: "pro-plus",
    quantity: 1,
    pauseMonths: 2,
    requestedAt: 1,
    pauseEffectiveAt: 2,
    resumeAt: RESUME_AT,
    status: "paused",
    resumeAttemptCount: 0,
    ...overrides,
  };
}

describe("AccountTab while a retention pause is active", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockConvexQueries();
  });

  it("shows nothing extra for free users without a pause", () => {
    setMockQueryResult(null);

    render(<AccountTab />);

    expect(screen.queryByText(/plan is paused/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade" })).toBeVisible();
  });

  it("shows the paused plan with its resume date and resumes on demand", async () => {
    setMockQueryResult(pausedRecord());
    mockResumeSubscription.mockResolvedValue({
      resumed: true,
      stripeSubscriptionId: "sub_new",
      alreadyActive: false,
    } as never);
    const resumeDate = new Intl.DateTimeFormat(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(RESUME_AT));

    render(<AccountTab />);

    expect(screen.getByText("Your Pro+ plan is paused.")).toBeVisible();
    expect(
      screen.getByText(
        `It resumes automatically on ${resumeDate}. Resume sooner anytime.`,
      ),
    ).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Resume now" }));

    await waitFor(() => {
      expect(mockResumeSubscription).toHaveBeenCalledTimes(1);
    });
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Plan resumed. Refreshing your account...",
    );
    expect(mockReloadWithEntitlementRefresh).toHaveBeenCalledTimes(1);
  });

  it("explains a failed automatic resume and surfaces the error on retry", async () => {
    setMockQueryResult(pausedRecord({ status: "resume_failed" }));
    mockResumeSubscription.mockRejectedValue(
      new Error(
        "We couldn't charge your saved payment method. Update it and try again.",
      ) as never,
    );

    render(<AccountTab />);

    expect(
      screen.getByText(
        /couldn't resume it automatically with your saved card/i,
      ),
    ).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Resume now" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "We couldn't charge your saved payment method. Update it and try again.",
      );
    });
    expect(mockReloadWithEntitlementRefresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Resume now" })).toBeEnabled();
  });
});
