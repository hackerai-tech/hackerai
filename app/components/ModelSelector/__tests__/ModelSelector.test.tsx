import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { SubscriptionTier } from "@/types/chat";

let mockSubscription: SubscriptionTier;
const mockIsHighCostModelUsageNoticeDismissed = jest.fn();
const mockDismissHighCostModelUsageNotice = jest.fn();

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: mockSubscription,
  }),
}));

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

jest.mock("@/lib/utils/pro-max-notice-cookie", () => ({
  isHighCostModelUsageNoticeDismissed: () =>
    mockIsHighCostModelUsageNoticeDismissed(),
  dismissHighCostModelUsageNotice: () => mockDismissHighCostModelUsageNotice(),
}));

const { ModelSelector } = jest.requireActual<
  typeof import("../../ModelSelector")
>("../../ModelSelector");

describe("ModelSelector", () => {
  beforeEach(() => {
    mockSubscription = "pro-plus";
    mockIsHighCostModelUsageNoticeDismissed.mockReturnValue(false);
    mockDismissHighCostModelUsageNotice.mockClear();
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

  it("selects HackerAI Pro in ask mode without the high-cost warning", () => {
    const onChange = jest.fn();
    render(<ModelSelector value="auto" onChange={onChange} mode="ask" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));
    fireEvent.click(screen.getByRole("button", { name: /HackerAI Pro/i }));

    expect(onChange).toHaveBeenCalledWith("hackerai-pro");
    expect(screen.queryByTestId("high-cost-model-warning")).toBeNull();
  });

  it("warns before selecting HackerAI Pro in agent mode on paid plans", () => {
    const onChange = jest.fn();
    render(<ModelSelector value="auto" onChange={onChange} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));
    fireEvent.click(screen.getByRole("button", { name: /HackerAI Pro/i }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("high-cost-model-warning")).toBeVisible();
    expect(screen.getByText("High-cost model")).toBeVisible();
    expect(
      screen.getByText(/long requests can use around \$10 of usage/i),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Use HackerAI Pro/i }));

    expect(mockDismissHighCostModelUsageNotice).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("hackerai-pro");
  });

  it("warns before selecting HackerAI Max on paid tiers above Pro", () => {
    mockSubscription = "ultra";
    const onChange = jest.fn();
    render(<ModelSelector value="auto" onChange={onChange} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));
    fireEvent.click(screen.getByRole("button", { name: /HackerAI Max/i }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("high-cost-model-warning")).toBeVisible();
    expect(screen.getByText(/HackerAI Max is powerful/i)).toBeVisible();
  });

  it("uses team-specific warning copy for team users", () => {
    mockSubscription = "team";
    const onChange = jest.fn();
    render(<ModelSelector value="auto" onChange={onChange} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));
    fireEvent.click(screen.getByRole("button", { name: /HackerAI Pro/i }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/your team's usage/i)).toBeVisible();
    expect(
      screen.getByText(/long requests can use around \$10 of usage/i),
    ).toBeVisible();
  });
});
