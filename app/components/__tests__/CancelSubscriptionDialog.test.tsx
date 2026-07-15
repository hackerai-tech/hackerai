import "@testing-library/jest-dom";
import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockCancelSubscription = jest.fn();
const mockToastSuccess = jest.fn();

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: "pro",
  }),
}));

jest.mock("@/lib/billing/client", () => ({
  cancelSubscription: mockCancelSubscription,
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: mockToastSuccess,
  },
}));

const CancelSubscriptionDialog = require("../CancelSubscriptionDialog")
  .default as typeof import("../CancelSubscriptionDialog").default;

describe("CancelSubscriptionDialog", () => {
  it("shows usage limits as a cancellation reason", () => {
    render(<CancelSubscriptionDialog open={true} onOpenChange={jest.fn()} />);

    expect(
      screen.getByRole("radio", { name: /hit usage limits too often/i }),
    ).toBeInTheDocument();
  });

  it("confirms that retries stopped when a past-due subscription is canceled immediately", async () => {
    const onCancellationCompleted = jest.fn();
    mockCancelSubscription.mockResolvedValue({
      canceled: true,
      cancelAtPeriodEnd: false,
      alreadyScheduled: false,
    } as never);
    const user = userEvent.setup();

    render(
      <CancelSubscriptionDialog
        open={true}
        onOpenChange={jest.fn()}
        onCancellationCompleted={onCancellationCompleted}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /other/i }));
    await user.type(
      screen.getByLabelText("Tell us what happened"),
      "The renewal failed",
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Confirm & Cancel" }));

    expect(
      await screen.findByRole("heading", { name: "Subscription canceled" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Your Pro subscription is canceled. We won't retry the failed renewal payment.",
      ),
    ).toBeVisible();
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Subscription canceled. Payment retries stopped.",
    );
    expect(onCancellationCompleted).toHaveBeenCalledWith({
      cancelAtPeriodEnd: false,
      currentPeriodEnd: undefined,
      alreadyScheduled: false,
    });
  });
});
