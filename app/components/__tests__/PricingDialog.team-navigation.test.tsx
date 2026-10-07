import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import PricingDialog from "../PricingDialog";
import TeamPricingDialog from "../TeamPricingDialog";
import { usePricingDialog } from "@/app/hooks/usePricingDialog";

const mockSetTeamPricingDialogOpen = jest.fn();

jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: { id: "free-user" } }),
}));

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: "free",
    isCheckingProPlan: false,
    setTeamPricingDialogOpen: mockSetTeamPricingDialogOpen,
  }),
}));

jest.mock("@/app/hooks/useUpgrade", () => ({
  useUpgrade: () => ({ upgradeLoading: false, handleUpgrade: jest.fn() }),
}));

jest.mock("@/lib/analytics/client", () => ({
  addAuthenticatedExceptionStep: jest.fn(),
  captureAuthenticatedEvent: jest.fn(() => true),
  captureUpgradeCtaImpression: jest.fn(),
}));

jest.mock("../UpgradeConfirmationDialog", () => ({
  __esModule: true,
  default: () => null,
}));

function FreePlanDialogs() {
  const [teamOpen, setTeamOpen] = React.useState(false);
  const { showPricing, handleClosePricing } = usePricingDialog("free");

  React.useEffect(() => {
    mockSetTeamPricingDialogOpen.mockImplementation(setTeamOpen);
  }, []);

  return (
    <>
      <PricingDialog isOpen={showPricing} onClose={handleClosePricing} />
      <TeamPricingDialog isOpen={teamOpen} onClose={() => setTeamOpen(false)} />
    </>
  );
}

describe("Free plan Team navigation", () => {
  beforeEach(() => {
    window.history.replaceState(
      {},
      "",
      "/?pricing_surface=sidebar_user_menu&pricing_source=account_menu&pricing_from_tier=free#pricing",
    );
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

  it("opens Team seat selection from the upgrade dialog", async () => {
    const user = userEvent.setup();
    render(<FreePlanDialogs />);

    await user.click(
      await screen.findByRole("button", { name: "View Team Plans" }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "Team Pricing" }),
      ).toBeVisible(),
    );
    expect(window.location.hash).toBe("#team-pricing-seat-selection");
    const params = new URLSearchParams(window.location.search);
    expect(params.get("selectedPlan")).toBe("monthly");
    expect(params.get("numSeats")).toBe("5");
    expect(params.has("pricing_surface")).toBe(false);
    expect(params.has("pricing_source")).toBe(false);
    expect(params.has("pricing_from_tier")).toBe(false);
  });
});
