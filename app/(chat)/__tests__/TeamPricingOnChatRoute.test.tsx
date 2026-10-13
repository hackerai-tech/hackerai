import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import ChatRouteLayout from "../layout";
import PricingDialog from "@/app/components/PricingDialog";
import { usePricingDialog } from "@/app/hooks/usePricingDialog";

type MockGlobalState = {
  subscription: "free";
  isCheckingProPlan: boolean;
  teamPricingDialogOpen: boolean;
  setTeamPricingDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

const mockGlobalStateContext = React.createContext<MockGlobalState | null>(
  null,
);

jest.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));

jest.mock("@/app/hooks/useHasAuthenticatedBefore", () => ({
  useHasAuthenticatedBefore: () => true,
}));

jest.mock("@/app/components/ChatLayout", () => ({
  ChatLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("@/app/contexts/ChatRoutePresentationContext", () => ({
  ChatRoutePresentationProvider: ({
    children,
  }: {
    children: React.ReactNode;
  }) => <>{children}</>,
}));

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => {
    const state = require("react").useContext(mockGlobalStateContext);
    if (!state) throw new Error("Missing test global state");
    return state;
  },
}));

jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: { id: "free-user" } }),
}));

jest.mock("@/app/hooks/useUpgrade", () => ({
  useUpgrade: () => ({ upgradeLoading: false, handleUpgrade: jest.fn() }),
}));

jest.mock("@/lib/analytics/client", () => ({
  addAuthenticatedExceptionStep: jest.fn(),
  captureAuthenticatedEvent: jest.fn(() => true),
  captureUpgradeCtaImpression: jest.fn(),
}));

jest.mock("@/app/components/UpgradeConfirmationDialog", () => ({
  __esModule: true,
  default: () => null,
}));

function ExistingChatPricing() {
  const { showPricing, handleClosePricing } = usePricingDialog("free");
  return <PricingDialog isOpen={showPricing} onClose={handleClosePricing} />;
}

function ExistingChatRoute() {
  const [teamPricingDialogOpen, setTeamPricingDialogOpen] = React.useState(
    () => window.location.hash === "#team-pricing-seat-selection",
  );

  return (
    <mockGlobalStateContext.Provider
      value={{
        subscription: "free",
        isCheckingProPlan: false,
        teamPricingDialogOpen,
        setTeamPricingDialogOpen,
      }}
    >
      <ChatRouteLayout>
        <ExistingChatPricing />
      </ChatRouteLayout>
    </mockGlobalStateContext.Provider>
  );
}

describe("Team pricing from an existing chat", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/c/existing-chat#pricing");
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        key: "hac46-pro-monthly-29-pricing",
        variant: "control",
        priceLookupKey: "pro-monthly-plan",
        displayedAmountDollars: 25,
        stripePriceId: "price_pro_25",
      }),
    }) as jest.Mock;
  });

  it("opens Team seat selection without leaving the chat route", async () => {
    const user = userEvent.setup();
    render(<ExistingChatRoute />);

    await user.click(
      await screen.findByRole("button", { name: "View Team Plans" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Team Pricing" }),
    ).toBeVisible();
    expect(window.location.pathname).toBe("/c/existing-chat");
    expect(window.location.hash).toBe("#team-pricing-seat-selection");
  });

  it("restores Team seat selection from a selected-chat URL", async () => {
    window.history.replaceState(
      {},
      "",
      "/c/existing-chat?selectedPlan=yearly&numSeats=3#team-pricing-seat-selection",
    );

    render(<ExistingChatRoute />);

    expect(
      await screen.findByRole("dialog", { name: "Team Pricing" }),
    ).toBeVisible();
  });
});
