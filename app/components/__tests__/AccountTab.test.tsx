import "@testing-library/jest-dom";
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockGetSubscriptionCancellationStatus = jest.fn();
const mockSetMigrateFromPentestgptDialogOpen = jest.fn();

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: "pro",
    setMigrateFromPentestgptDialogOpen: mockSetMigrateFromPentestgptDialogOpen,
  }),
}));

jest.mock("@/app/hooks/usePentestgptMigration", () => ({
  usePentestgptMigration: () => ({ isMigrating: false }),
}));

jest.mock("@/app/hooks/usePricingDialog", () => ({
  redirectToPricing: jest.fn(),
}));

jest.mock("@/lib/actions/billing-portal", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@/lib/actions/subscription-status", () => ({
  __esModule: true,
  default: mockGetSubscriptionCancellationStatus,
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

describe("AccountTab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows scheduled cancellation state instead of the cancel action", async () => {
    const currentPeriodEnd = Date.UTC(2026, 6, 31, 12);
    const expectedPeriodEnd = new Intl.DateTimeFormat(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(currentPeriodEnd));

    mockGetSubscriptionCancellationStatus.mockResolvedValue({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd,
    } as never);

    render(<AccountTab />);

    expect(await screen.findByText("Cancellation scheduled.")).toBeVisible();
    expect(
      screen.getByText(`Your plan stays active until ${expectedPeriodEnd}.`),
    ).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /manage/i })[0]);

    await waitFor(() => {
      expect(screen.getByText("Cancellation scheduled")).toBeVisible();
    });
    expect(screen.queryByText("Cancel subscription")).not.toBeInTheDocument();
  });

  it("keeps the cancel action when cancellation is not scheduled", async () => {
    mockGetSubscriptionCancellationStatus.mockResolvedValue({
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
    } as never);

    render(<AccountTab />);

    await waitFor(() => {
      expect(mockGetSubscriptionCancellationStatus).toHaveBeenCalledTimes(1);
    });

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /manage/i })[0]);

    expect(screen.getByText("Cancel subscription")).toBeVisible();
    expect(
      screen.queryByText("Cancellation scheduled."),
    ).not.toBeInTheDocument();
  });

  it("does not offer cancellation when no active subscription is found", async () => {
    mockGetSubscriptionCancellationStatus.mockResolvedValue({
      hasActiveSubscription: false,
      cancelAtPeriodEnd: false,
    } as never);

    render(<AccountTab />);

    await waitFor(() => {
      expect(mockGetSubscriptionCancellationStatus).toHaveBeenCalledTimes(1);
    });

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /manage/i })[0]);

    expect(screen.getByText("No active subscription")).toBeVisible();
    expect(screen.queryByText("Cancel subscription")).not.toBeInTheDocument();
  });
});
