import "@testing-library/jest-dom";
import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: "pro",
  }),
}));

jest.mock("@/lib/billing/client", () => ({
  cancelSubscription: jest.fn(),
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
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
});
