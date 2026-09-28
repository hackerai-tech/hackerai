import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { SubscriptionTier } from "@/types/chat";

let mockSubscription: SubscriptionTier;
let mockMaxEntitlement: unknown;
let mockIsMobile: boolean;
const mockUseQuery = jest.fn((_query: unknown, args: unknown) =>
  args === "skip" ? undefined : mockMaxEntitlement,
);
const mockRedirectToPricing = jest.fn();
const mockOpenSettingsDialog = jest.fn();
let mockUploadedFiles: Array<{ file: { type: string } }>;
let mockOrcaRouterConnection: unknown;
let mockOrcaRouterCatalog: unknown;
const mockUseOrcaRouterConnection = jest.fn((enabled: boolean) => ({
  connection: enabled ? mockOrcaRouterConnection : undefined,
}));
const mockUseOrcaRouterModels = jest.fn((enabled: boolean) => ({
  catalog: enabled ? mockOrcaRouterCatalog : undefined,
  isLoading: false,
  refresh: jest.fn(),
}));
const mockToastMessage = jest.fn();

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
    uploadedFiles: mockUploadedFiles,
  }),
}));

jest.mock("@/app/hooks/useOrcaRouter", () => ({
  MODEL_PROVIDERS_SETTINGS_TAB: "Model providers",
  useOrcaRouterConnection: (enabled: boolean) =>
    mockUseOrcaRouterConnection(enabled),
  useOrcaRouterModels: (enabled: boolean) => mockUseOrcaRouterModels(enabled),
}));

jest.mock("sonner", () => ({
  toast: { message: (...args: unknown[]) => mockToastMessage(...args) },
}));

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mockIsMobile,
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
    mockIsMobile = false;
    mockUploadedFiles = [];
    mockOrcaRouterConnection = { enabled: false, connected: false };
    mockOrcaRouterCatalog = undefined;
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

  it("discloses the Agent Standard and Pro providers", async () => {
    const user = userEvent.setup();
    render(<ModelSelector value="auto" onChange={jest.fn()} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));

    await user.hover(
      screen.getByRole("button", { name: /HackerAI Standard/i }),
    );
    expect(
      await screen.findAllByText("Powered by Z.ai GLM 5.3 Flash"),
    ).not.toHaveLength(0);

    await user.unhover(
      screen.getByRole("button", { name: /HackerAI Standard/i }),
    );
    await user.hover(screen.getByRole("button", { name: /HackerAI Pro/i }));
    expect(
      await screen.findAllByText("Powered by DeepSeek V4.1 Flash"),
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

  it("opens the Max access dialog when a Pro Plus user clicks the locked desktop row", () => {
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
      "HackerAI Max. Use Extra Usage or upgrade to Ultra for Max mode.",
    );

    fireEvent.click(maxButton);

    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Unlock HackerAI Max" }),
    ).toBeVisible();
    expect(
      screen.getByText(/pay for Max as you go, or upgrade to Ultra/i),
    ).toBeVisible();
    expect(mockOpenSettingsDialog).not.toHaveBeenCalled();
    expect(mockRedirectToPricing).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Use Extra Usage" }));

    expect(mockOpenSettingsDialog).toHaveBeenCalledWith("Extra Usage");
  });

  it("does not reveal inline Max access actions on desktop hover", async () => {
    mockMaxEntitlement = {
      extraUsageAvailable: false,
      reason: "disabled",
      hasBalance: false,
      autoReloadEnabled: false,
    };
    const user = userEvent.setup();
    render(<ModelSelector value="auto" onChange={jest.fn()} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));
    await user.hover(screen.getByRole("button", { name: /HackerAI Max/i }));

    expect(
      screen.queryByRole("group", {
        name: "Choose how to access HackerAI Max",
      }),
    ).not.toBeInTheDocument();
  });

  it("can upgrade to Ultra from the locked Max desktop dialog", () => {
    mockMaxEntitlement = {
      extraUsageAvailable: false,
      reason: "disabled",
      hasBalance: false,
      autoReloadEnabled: false,
    };
    render(<ModelSelector value="auto" onChange={jest.fn()} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));
    fireEvent.click(screen.getByRole("button", { name: /HackerAI Max/i }));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Ultra" }));

    expect(mockRedirectToPricing).toHaveBeenCalledWith({
      surface: "model_selector",
      source: "max_model_gate",
      from_tier: "pro-plus",
      cta_text: "Upgrade to Ultra",
    });
    expect(mockOpenSettingsDialog).not.toHaveBeenCalled();
  });

  it("shows both Max access choices after a locked mobile selection", () => {
    mockIsMobile = true;
    mockMaxEntitlement = {
      extraUsageAvailable: false,
      reason: "disabled",
      hasBalance: false,
      autoReloadEnabled: false,
    };
    const onChange = jest.fn();
    render(<ModelSelector value="auto" onChange={onChange} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));
    fireEvent.click(screen.getByRole("button", { name: /HackerAI Max/i }));

    expect(
      screen.getByRole("dialog", { name: "Unlock HackerAI Max" }),
    ).toBeVisible();
    expect(
      screen.getByText(/pay for Max as you go, or upgrade to Ultra/i),
    ).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
    expect(mockOpenSettingsDialog).not.toHaveBeenCalled();
    expect(mockRedirectToPricing).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Use Extra Usage" }));

    expect(mockOpenSettingsDialog).toHaveBeenCalledWith("Extra Usage");
    expect(mockRedirectToPricing).not.toHaveBeenCalled();
  });

  it("can upgrade to Ultra from the locked Max mobile dialog", () => {
    mockIsMobile = true;
    mockMaxEntitlement = {
      extraUsageAvailable: false,
      reason: "empty",
      hasBalance: false,
      autoReloadEnabled: false,
    };
    render(<ModelSelector value="auto" onChange={jest.fn()} mode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));
    fireEvent.click(screen.getByRole("button", { name: /HackerAI Max/i }));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Ultra" }));

    expect(mockRedirectToPricing).toHaveBeenCalledWith({
      surface: "model_selector_mobile",
      source: "max_model_gate",
      from_tier: "pro-plus",
      cta_text: "Upgrade to Ultra",
    });
    expect(mockOpenSettingsDialog).not.toHaveBeenCalled();
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

describe("ModelSelector OrcaRouter models", () => {
  // Shape returned by /api/orcarouter/models after catalog parsing: the
  // server already dropped embedding, image-generation, video and rerank
  // records, so only chat models (with their declared modalities) remain.
  const liveCatalog = {
    status: "live",
    models: [
      { id: "deepseek/deepseek-v4-pro", inputModalities: ["text"] },
      { id: "openai/gpt-5.5", inputModalities: ["text", "image"] },
      { id: "orcarouter/auto", inputModalities: [] },
    ],
  };

  beforeEach(() => {
    mockSubscription = "pro";
    mockMaxEntitlement = undefined;
    mockIsMobile = false;
    mockUploadedFiles = [];
    mockOrcaRouterConnection = {
      enabled: true,
      connected: true,
      source: "api_key",
      status: "active",
      keyHint: "…abcd",
      updatedAt: 1,
    };
    mockOrcaRouterCatalog = liveCatalog;
    mockOpenSettingsDialog.mockClear();
    mockToastMessage.mockClear();
    mockUseOrcaRouterModels.mockClear();
  });

  const openSelector = () =>
    fireEvent.click(screen.getByRole("button", { name: /^Auto$/i }));

  it("lists the live catalog from the API and selects a namespaced model", () => {
    const onChange = jest.fn();
    render(<ModelSelector value="auto" onChange={onChange} mode="ask" />);

    expect(mockUseOrcaRouterModels).toHaveBeenLastCalledWith(false);
    openSelector();
    expect(mockUseOrcaRouterModels).toHaveBeenLastCalledWith(true);

    const options = screen
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual([
      "deepseek/deepseek-v4-pro",
      "openai/gpt-5.5",
      "orcarouter/auto",
    ]);

    fireEvent.click(screen.getByRole("option", { name: "openai/gpt-5.5" }));
    expect(onChange).toHaveBeenCalledWith("orcarouter:openai/gpt-5.5");
  });

  it("offers only models that declare image input when an image is attached", () => {
    mockUploadedFiles = [{ file: { type: "image/png" } }];
    render(<ModelSelector value="auto" onChange={jest.fn()} mode="ask" />);
    openSelector();

    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["openai/gpt-5.5"]);
  });

  it("clears a selected text-only model once an image is attached", () => {
    mockUploadedFiles = [{ file: { type: "image/jpeg" } }];
    const onChange = jest.fn();
    render(
      <ModelSelector
        value="orcarouter:deepseek/deepseek-v4-pro"
        onChange={onChange}
        mode="ask"
      />,
    );

    expect(onChange).toHaveBeenCalledWith("auto");
    expect(mockToastMessage).toHaveBeenCalledWith(
      "The selected OrcaRouter model does not accept images. Switched to Auto.",
    );
  });

  it("keeps a compatible selection and shows it on the trigger", () => {
    const onChange = jest.fn();
    render(
      <ModelSelector
        value="orcarouter:openai/gpt-5.5"
        onChange={onChange}
        mode="ask"
      />,
    );

    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "openai/gpt-5.5" }),
    ).toBeVisible();
  });

  it("clears a model the live catalog no longer lists", () => {
    const onChange = jest.fn();
    render(
      <ModelSelector
        value="orcarouter:acme/retired-model"
        onChange={onChange}
        mode="ask"
      />,
    );
    expect(onChange).toHaveBeenCalledWith("auto");
  });

  it("labels the verified fallback instead of offering free-text input", () => {
    mockOrcaRouterCatalog = {
      status: "fallback",
      reason: "network",
      models: [{ id: "openai/gpt-5.5", inputModalities: ["text", "image"] }],
    };
    render(<ModelSelector value="auto" onChange={jest.fn()} mode="ask" />);
    openSelector();

    expect(
      screen.getByText("Live catalog unavailable — showing verified defaults"),
    ).toBeVisible();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("links to Model providers when OrcaRouter is not connected", () => {
    mockOrcaRouterConnection = { enabled: true, connected: false };
    render(<ModelSelector value="auto" onChange={jest.fn()} mode="ask" />);
    openSelector();

    fireEvent.click(screen.getByRole("button", { name: "Connect OrcaRouter" }));
    expect(mockOpenSettingsDialog).toHaveBeenCalledWith("Model providers");
    expect(mockUseOrcaRouterModels).toHaveBeenLastCalledWith(false);
  });

  it("asks to reconnect after the saved key was rejected", () => {
    mockOrcaRouterConnection = {
      enabled: true,
      connected: true,
      source: "pkce",
      status: "needs_reauth",
      keyHint: "…abcd",
      updatedAt: 1,
    };
    render(<ModelSelector value="auto" onChange={jest.fn()} mode="ask" />);
    openSelector();

    expect(
      screen.getByRole("button", { name: "Reconnect OrcaRouter" }),
    ).toBeVisible();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("hides OrcaRouter in Agent mode and shows the selection as Auto", () => {
    render(
      <ModelSelector
        value="orcarouter:openai/gpt-5.5"
        onChange={jest.fn()}
        mode="agent"
      />,
    );
    openSelector();
    expect(
      screen.queryByTestId("orcarouter-model-group"),
    ).not.toBeInTheDocument();
  });

  it("offers OrcaRouter models to free Ask users", () => {
    mockSubscription = "free";
    const onChange = jest.fn();
    render(<ModelSelector value="auto" onChange={onChange} mode="ask" />);
    fireEvent.click(screen.getByRole("button", { name: /^Model$/i }));

    fireEvent.click(screen.getByRole("option", { name: "openai/gpt-5.5" }));
    expect(onChange).toHaveBeenCalledWith("orcarouter:openai/gpt-5.5");
  });

  it("lets a free user on an OrcaRouter model return to Auto", () => {
    mockSubscription = "free";
    const onChange = jest.fn();
    render(
      <ModelSelector
        value="orcarouter:openai/gpt-5.5"
        onChange={onChange}
        mode="ask"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "openai/gpt-5.5" }));
    fireEvent.click(
      screen.getByRole("button", { name: /Auto Balanced quality and speed/i }),
    );
    expect(onChange).toHaveBeenCalledWith("auto");
  });
});
