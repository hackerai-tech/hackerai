import { render, screen } from "@testing-library/react";
import { AutoReloadDisabledAlert } from "../AutoReloadDisabledAlert";

describe("AutoReloadDisabledAlert", () => {
  it("renders Stripe decline reasons without repeated card wording or duplicate punctuation", () => {
    render(
      <AutoReloadDisabledAlert reason="Your card was declined for making repeated attempts too frequently or exceeding its amount limit." />,
    );

    const alert = screen.getByRole("alert");

    expect(alert).toHaveTextContent(
      "Auto-reload was turned off after failed payment attempts. Your card was declined for making repeated attempts too frequently or exceeding its amount limit. Update your payment method, then turn auto-reload back on.",
    );
    expect(alert).not.toHaveTextContent("card kept failing");
    expect(alert).not.toHaveTextContent("..");
  });

  it("uses billing portal copy for team payment methods", () => {
    render(
      <AutoReloadDisabledAlert reason="Payment failed" updateInBillingPortal />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Update your payment method in the billing portal, then turn auto-reload back on.",
    );
  });

  it("normalizes fallback failure codes", () => {
    render(<AutoReloadDisabledAlert reason="payment_failed" />);

    expect(screen.getByRole("alert")).toHaveTextContent("Payment failed.");
  });
});
