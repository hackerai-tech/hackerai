import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { SubscriptionTier } from "@/types/chat";

let mockSubscription: SubscriptionTier;
let mockMaxEntitlement: unknown;
const mockUseQuery = jest.fn((_query: unknown, args: unknown) =>
  args === "skip" ? undefined : mockMaxEntitlement,
);
const mockRedirectToPricing = jest.fn();
const mockOpenSettingsDialog = jest.fn();

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: class ResizeObserverMock {
    observe() {
      return undefined;
    }

    unobserve() {
      return undefined;
    }

    disconnect() {
      return undefined;
    }
  },
});

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

jest.mock("@/lib/utils/settings-dialog", () => ({
  openSettingsDialog: (...args: unknown[]) => mockOpenSettingsDialog(...args),
}));

jest.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

const { ModelSelector } = jest.requireActual<
  typeof import("../../ModelSelector")
>("../../ModelSelector");

describe("ModelSelector", () => {
  beforeEach(() => {
    mockSubscription = "pro-plus";
    mockMaxEntitlement = undefined;
    mockUseQuery.mockClear();
    mockRedirectToPricing.mockClear();
    mockOpenSettingsDialog.mockClear();
  });

  it("skips the Max entitlement query until a paid user opens the selector", () => {
    render(<ModelSelector value="auto" onChange={jest.fn()} mode="agent" />);

    expect(mockUseQuery).toHaveBeenLastCalledWith(expect.anything(), "skip");

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));

    expect(mockUseQuery).toHaveBeenLastCalledWith(expect.anything(), {});
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

  it("uses consistent vision wording for Agent Standard and Pro", async () => {
    const user = userEvent.setup();
    render(<ModelSelector value="auto" onChange={jest.fn()} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));

    await user.hover(
      screen.getByRole("button", { name: /HackerAI Standard/i }),
    );
    expect(
      await screen.findAllByText(
        "Powered by DeepSeek V4 Pro · MiniMax M3 for vision",
      ),
    ).not.toHaveLength(0);

    await user.unhover(
      screen.getByRole("button", { name: /HackerAI Standard/i }),
    );
    await user.hover(screen.getByRole("button", { name: /HackerAI Pro/i }));
    expect(
      await screen.findAllByText(
        "Powered by Z.ai GLM 5.2 · Grok 4.5 for vision",
      ),
    ).not.toHaveLength(0);
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

  it("locks HackerAI Max on Pro Plus and opens Extra Usage settings", () => {
    mockMaxEntitlement = {
      extraUsageAvailable: false,
      reason: "disabled",
      hasBalance: false,
      autoReloadEnabled: false,
    };
    const onChange = jest.fn();
    render(<ModelSelector value="auto" onChange={onChange} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));
    const maxButton = screen.getByRole("button", { name: /HackerAI Max/i });

    expect(maxButton).toHaveAccessibleName(
      "HackerAI Max. Set up Extra Usage for Max mode.",
    );

    fireEvent.click(maxButton);

    expect(onChange).not.toHaveBeenCalled();
    expect(mockOpenSettingsDialog).toHaveBeenCalledWith("Extra Usage");
    expect(mockRedirectToPricing).not.toHaveBeenCalled();
  });

  it("shows a checking state while lazy Max entitlement is loading", () => {
    const onChange = jest.fn();
    render(<ModelSelector value="auto" onChange={onChange} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));

    const maxButton = screen.getByRole("button", { name: /HackerAI Max/i });
    expect(maxButton).toHaveAccessibleName(
      "HackerAI Max. Checking Extra Usage for Max mode.",
    );
    expect(maxButton).toBeDisabled();

    fireEvent.click(maxButton);

    expect(onChange).not.toHaveBeenCalled();
    expect(mockOpenSettingsDialog).not.toHaveBeenCalled();
  });

  it("selects HackerAI Max on Pro Plus when extra usage is available", () => {
    mockMaxEntitlement = {
      extraUsageAvailable: true,
      reason: "available",
      hasBalance: true,
      autoReloadEnabled: false,
    };
    const onChange = jest.fn();
    render(<ModelSelector value="auto" onChange={onChange} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));
    fireEvent.click(screen.getByRole("button", { name: /HackerAI Max/i }));

    expect(onChange).toHaveBeenCalledWith("hackerai-max");
    expect(mockRedirectToPricing).not.toHaveBeenCalled();
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
    expect(mockOpenSettingsDialog).toHaveBeenCalledWith("Extra Usage");
    expect(mockRedirectToPricing).not.toHaveBeenCalled();
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
    mockMaxEntitlement = {
      extraUsageAvailable: false,
      reason: "empty",
      hasBalance: false,
      autoReloadEnabled: false,
    };

    render(
      <ModelSelector value="hackerai-max" onChange={jest.fn()} mode="agent" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /HackerAI Pro/i }));

    const proButton = screen
      .getAllByRole("button", { name: /HackerAI Pro/i })
      .find((button) => button.hasAttribute("aria-pressed"));
    const maxButton = screen.getByRole("button", { name: /HackerAI Max/i });

    expect(proButton).toBeDefined();
    expect(proButton).toHaveAttribute("aria-pressed", "true");
    expect(maxButton).toHaveAttribute("aria-pressed", "false");
  });

  it("displays stale Max as selected for Pro users with extra usage available", () => {
    mockSubscription = "pro";
    mockMaxEntitlement = {
      extraUsageAvailable: true,
      reason: "available",
      hasBalance: false,
      autoReloadEnabled: true,
    };

    render(
      <ModelSelector value="hackerai-max" onChange={jest.fn()} mode="agent" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /HackerAI Max/i }));

    const maxButton = screen
      .getAllByRole("button", { name: /HackerAI Max/i })
      .find((button) => button.hasAttribute("aria-pressed"));

    expect(maxButton).toBeDefined();
    expect(maxButton).toHaveAttribute("aria-pressed", "true");
  });
});
