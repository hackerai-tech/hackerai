import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { PricingPlans } from "../PricingPlans";

let mockUser: { id: string } | null = null;
let mockPriceState: Record<string, unknown> = { status: "signed-out" };
const mockRetry = jest.fn();
const mockEnabled: boolean[] = [];

jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: mockUser }),
}));
jest.mock("@/app/hooks/useProMonthlyPrice", () => {
  const actual = jest.requireActual("@/app/hooks/useProMonthlyPrice");
  return {
    ...actual,
    useProMonthlyPrice: (enabled: boolean) => {
      mockEnabled.push(enabled);
      return { ...mockPriceState, retry: mockRetry };
    },
    useProMonthlyPriceExposure: jest.fn(),
  };
});

const proCard = () => within(screen.getByRole("article", { name: "Pro plan" }));
const chooseYearly = () =>
  fireEvent.click(screen.getByLabelText("Yearly billing"));

describe("public Pro price", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = null;
    mockPriceState = { status: "signed-out" };
    mockEnabled.length = 0;
  });

  it("shows a signed-out visitor a starting price, never a definite $29 promise", () => {
    render(<PricingPlans />);
    expect(proCard().getByText("From")).toBeVisible();
    expect(proCard().getByText("$29")).toBeVisible();
    expect(mockEnabled.every((enabled) => !enabled)).toBe(true);

    chooseYearly();
    expect(proCard().getByText("$288 billed yearly")).toBeVisible();
    expect(proCard().queryByText(/\$29\/month/)).not.toBeInTheDocument();
    // Other plans keep their unchanged public comparison.
    expect(
      screen.getByText("$600 billed yearly · $60/month if billed monthly"),
    ).toBeVisible();
  });

  it("holds the price space without an amount while a signed-in price resolves", () => {
    mockUser = { id: "user-1" };
    mockPriceState = { status: "loading" };
    render(<PricingPlans />);
    expect(mockEnabled).toContain(true);
    expect(proCard().queryByText("$29")).not.toBeInTheDocument();
    expect(proCard().queryByText("From")).not.toBeInTheDocument();
    expect(proCard().getByText("Loading price")).toBeInTheDocument();
  });

  it("shows a signed-in account its resolved price in monthly and yearly views", () => {
    mockUser = { id: "user-1" };
    mockPriceState = {
      status: "ready",
      quote: {
        price: {
          priceLookupKey: "pro-monthly-plan-49-hac248",
          displayedAmountDollars: 49,
          currency: "usd",
          billingInterval: "month",
          stripePriceId: "price_pro_49",
        },
      },
    };
    render(<PricingPlans />);
    expect(proCard().getByText("$49")).toBeVisible();
    expect(proCard().queryByText("From")).not.toBeInTheDocument();
    chooseYearly();
    expect(
      proCard().getByText("$288 billed yearly · $49/month if billed monthly"),
    ).toBeVisible();
  });

  it("falls back to a starting price with a retry when the account price fails", () => {
    mockUser = { id: "user-1" };
    mockPriceState = { status: "error" };
    render(<PricingPlans />);
    expect(proCard().getByText("From")).toBeVisible();
    expect(proCard().getByText(/Couldn’t confirm your price\./)).toBeVisible();
    fireEvent.click(proCard().getByRole("button", { name: "Retry" }));
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });
});
