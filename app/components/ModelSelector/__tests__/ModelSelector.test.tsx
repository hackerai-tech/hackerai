import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { SubscriptionTier } from "@/types/chat";

let mockSubscription: SubscriptionTier;
const mockRedirectToPricing = jest.fn();

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: mockSubscription,
  }),
}));

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

jest.mock("@/app/hooks/usePricingDialog", () => ({
  redirectToPricing: (...args: unknown[]) => mockRedirectToPricing(...args),
}));

const { ModelSelector } = jest.requireActual<
  typeof import("../../ModelSelector")
>("../../ModelSelector");

describe("ModelSelector", () => {
  beforeEach(() => {
    mockSubscription = "pro-plus";
    mockRedirectToPricing.mockClear();
  });

  it("shows model choices immediately while Auto is selected", () => {
    render(<ModelSelector value="auto" onChange={jest.fn()} mode="ask" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));

    expect(
      screen.getByText(
        "Balanced quality and speed, recommended for most tasks",
      ),
    ).toBeVisible();
    expect(screen.getByText("HackerAI Standard")).toBeVisible();
    expect(screen.getByText("HackerAI Pro")).toBeVisible();
    expect(screen.getByText("HackerAI Max")).toBeVisible();

    expect(
      screen.getByRole("button", { name: /HackerAI Standard/i }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("selects Auto as a first-class option", () => {
    const onChange = jest.fn();
    render(
      <ModelSelector value="hackerai-pro" onChange={onChange} mode="ask" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /HackerAI Pro/i }));
    fireEvent.click(
      screen.getByRole("button", {
        name: /Auto Balanced quality and speed/i,
      }),
    );

    expect(onChange).toHaveBeenCalledWith("auto");
  });

  it("selects HackerAI Pro in ask mode without a high-cost warning", () => {
    const onChange = jest.fn();
    render(<ModelSelector value="auto" onChange={onChange} mode="ask" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));
    fireEvent.click(screen.getByRole("button", { name: /HackerAI Pro/i }));

    expect(
      screen.queryByTestId("high-cost-model-warning"),
    ).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith("hackerai-pro");
  });

  it("selects HackerAI Pro in agent mode without a high-cost warning", () => {
    const onChange = jest.fn();
    render(<ModelSelector value="auto" onChange={onChange} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));
    fireEvent.click(screen.getByRole("button", { name: /HackerAI Pro/i }));

    expect(
      screen.queryByTestId("high-cost-model-warning"),
    ).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith("hackerai-pro");
  });

  it("locks HackerAI Max on Pro Plus and routes to Ultra pricing", () => {
    const onChange = jest.fn();
    render(<ModelSelector value="auto" onChange={onChange} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));
    fireEvent.click(screen.getByRole("button", { name: /HackerAI Max/i }));

    expect(onChange).not.toHaveBeenCalled();
    expect(mockRedirectToPricing).toHaveBeenCalledWith({
      surface: "model_selector",
      source: "max_model_gate",
      from_tier: "pro-plus",
      cta_text: "Upgrade to Ultra",
    });
  });

  it("selects HackerAI Max for Ultra users", () => {
    mockSubscription = "ultra";
    const onChange = jest.fn();
    render(<ModelSelector value="auto" onChange={onChange} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));
    fireEvent.click(screen.getByRole("button", { name: /HackerAI Max/i }));

    expect(onChange).toHaveBeenCalledWith("hackerai-max");
  });

  it("locks HackerAI Max for team users", () => {
    mockSubscription = "team";
    const onChange = jest.fn();
    render(<ModelSelector value="auto" onChange={onChange} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));
    fireEvent.click(screen.getByRole("button", { name: /HackerAI Max/i }));

    expect(onChange).not.toHaveBeenCalled();
    expect(mockRedirectToPricing).toHaveBeenCalledWith({
      surface: "model_selector",
      source: "max_model_gate",
      from_tier: "team",
      cta_text: "Upgrade to Ultra",
    });
  });

  it("does not display a stale paid model as selected for free users", () => {
    mockSubscription = "free";

    render(
      <ModelSelector value="hackerai-pro" onChange={jest.fn()} mode="agent" />,
    );

    expect(screen.getByRole("button", { name: /^Auto$/i })).toBeVisible();
  });

  it("does not display stale Max as selected outside Ultra", () => {
    mockSubscription = "pro";

    render(
      <ModelSelector value="hackerai-max" onChange={jest.fn()} mode="agent" />,
    );

    expect(screen.getByRole("button", { name: /HackerAI Pro/i })).toBeVisible();
  });
});
