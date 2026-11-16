import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import type { SubscriptionTier } from "@/types";

let mockSubscription: SubscriptionTier = "free";
let mockChatModeAccessResolved = true;
let mockPaidAgentOnlyActive = false;
let mockFreeDesktopAgentOnlyActive = false;
let mockHasLocalSandbox = false;
let mockSandboxPreference = "e2b";
let mockFreeAgentGateActive = false;
let mockFreeAgentActivationStatus: {
  variant: "control" | "test";
  completedAskResponses: number;
  introLimit: number;
  requiresAgent: boolean;
} | null = null;
const mockSetSandboxPreference = jest.fn();

jest.mock("@/app/components/AttachmentButton", () => ({
  AttachmentButton: () => <button type="button">Attach</button>,
}));

jest.mock("../ChatModeSelector", () => ({
  ChatModeSelector: () => <div data-testid="chat-mode-selector" />,
}));

jest.mock("../FreeAskComputerActivation", () => ({
  FreeAskComputerActivation: () => (
    <div data-testid="free-ask-computer-activation" />
  ),
}));

jest.mock("@/app/components/ModelSelector", () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));

jest.mock("@/app/components/AgentPermissionSelector", () => ({
  AgentPermissionSelector: () => (
    <div data-testid="agent-permission-selector" />
  ),
}));

jest.mock("@/app/components/SandboxSelector", () => ({
  SandboxSelector: ({
    size,
    value,
    onChange,
  }: {
    size?: string;
    value?: string;
    onChange?: (value: string) => void;
  }) => (
    <button
      type="button"
      data-testid="sandbox-selector"
      data-size={size}
      data-value={value}
      onClick={() => onChange?.("local")}
    />
  ),
}));

jest.mock("../SubmitStopButton", () => ({
  SubmitStopButton: ({
    isPaid,
    useNeutralAgentStyle,
  }: {
    isPaid?: boolean;
    useNeutralAgentStyle?: boolean;
  }) => (
    <button
      type="button"
      data-is-paid={String(isPaid)}
      data-neutral-agent-style={String(useNeutralAgentStyle)}
    >
      Send
    </button>
  ),
}));

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    selectedModel: "auto",
    setSelectedModel: jest.fn(),
    subscription: mockSubscription,
    chatModeAccessResolved: mockChatModeAccessResolved,
    hasLocalSandbox: mockHasLocalSandbox,
    paidAgentOnlyActive: mockPaidAgentOnlyActive,
    freeDesktopAgentOnlyActive: mockFreeDesktopAgentOnlyActive,
    sandboxPreference: mockSandboxPreference,
    setSandboxPreference: mockSetSandboxPreference,
    freeAgentGateActive: mockFreeAgentGateActive,
    freeAgentActivationStatus: mockFreeAgentActivationStatus,
  }),
}));

const { ChatInputToolbar } = jest.requireActual<
  typeof import("../ChatInputToolbar")
>("../ChatInputToolbar");

const defaultProps = {
  onAttachClick: jest.fn(),
  isGenerating: false,
  hideStop: false,
  onStop: jest.fn(),
  onSubmit: jest.fn(),
  status: "ready" as const,
  isUploadingFiles: false,
  input: "",
  uploadedFiles: [],
  chatMode: "ask" as const,
};

const mockAuthUser = (user: unknown) => {
  jest.mocked(useAuth).mockReturnValue({
    user,
    entitlements: [],
    isAuthenticated: Boolean(user),
    signIn: jest.fn(),
    signOut: jest.fn(),
  } as ReturnType<typeof useAuth>);
};

describe("ChatInputToolbar", () => {
  beforeEach(() => {
    mockSubscription = "free";
    mockChatModeAccessResolved = true;
    mockPaidAgentOnlyActive = false;
    mockFreeDesktopAgentOnlyActive = false;
    mockHasLocalSandbox = false;
    mockSandboxPreference = "e2b";
    mockFreeAgentGateActive = false;
    mockFreeAgentActivationStatus = null;
    mockSetSandboxPreference.mockClear();
    mockAuthUser(null);
  });

  describe("free Agent activation gate", () => {
    const testStatus = (completedAskResponses: number) => ({
      variant: "test" as const,
      completedAskResponses,
      introLimit: 3,
      requiresAgent: completedAskResponses >= 3,
    });

    it("hints only when one introductory Ask reply is left", () => {
      mockAuthUser({ id: "user_123" });
      const hint = () => screen.queryByText("1 free Ask reply left");

      for (const completed of [0, 1]) {
        mockFreeAgentActivationStatus = testStatus(completed);
        const { unmount } = render(<ChatInputToolbar {...defaultProps} />);
        expect(hint()).not.toBeInTheDocument();
        unmount();
      }

      mockFreeAgentActivationStatus = testStatus(2);
      const { rerender } = render(<ChatInputToolbar {...defaultProps} />);
      expect(hint()).toBeInTheDocument();

      mockFreeAgentActivationStatus = { ...testStatus(2), variant: "control" };
      rerender(<ChatInputToolbar {...defaultProps} />);
      expect(hint()).not.toBeInTheDocument();
    });

    it("hides Ask and the Cloud selector until the gated user has a computer", () => {
      mockAuthUser({ id: "user_123" });
      mockFreeAgentGateActive = true;
      mockFreeAgentActivationStatus = testStatus(3);

      const { rerender } = render(
        <ChatInputToolbar {...defaultProps} chatMode="agent" />,
      );

      expect(
        screen.queryByTestId("chat-mode-selector"),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("sandbox-selector")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute(
        "data-neutral-agent-style",
        "true",
      );

      mockSandboxPreference = "runner-1";
      rerender(<ChatInputToolbar {...defaultProps} chatMode="agent" />);
      expect(
        within(screen.getByTestId("chat-input-desktop-sandbox")).getByTestId(
          "sandbox-selector",
        ),
      ).toHaveAttribute("data-value", "runner-1");
      expect(
        screen.queryByTestId("chat-mode-selector"),
      ).not.toBeInTheDocument();
    });
  });

  it.each(["ask", "agent"] as const)(
    "hides all selectors for logged-out users in %s mode",
    (chatMode) => {
      render(<ChatInputToolbar {...defaultProps} chatMode={chatMode} />);

      expect(
        screen.queryByTestId("chat-mode-selector"),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("model-selector")).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("agent-permission-selector"),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("sandbox-selector")).not.toBeInTheDocument();
    },
  );

  it("shows the model selector for logged-in users", () => {
    mockAuthUser({ id: "user_123" });

    render(<ChatInputToolbar {...defaultProps} />);

    expect(screen.getByTestId("model-selector")).toBeInTheDocument();
  });

  it("shows computer activation only for logged-in free Ask users without a local sandbox", () => {
    mockAuthUser({ id: "user_123" });

    const { rerender } = render(<ChatInputToolbar {...defaultProps} />);
    expect(
      screen.getByTestId("free-ask-computer-activation"),
    ).toBeInTheDocument();

    mockHasLocalSandbox = true;
    rerender(<ChatInputToolbar {...defaultProps} />);
    expect(
      screen.queryByTestId("free-ask-computer-activation"),
    ).not.toBeInTheDocument();

    mockHasLocalSandbox = false;
    rerender(<ChatInputToolbar {...defaultProps} chatMode="agent" />);
    expect(
      screen.queryByTestId("free-ask-computer-activation"),
    ).not.toBeInTheDocument();

    mockSubscription = "pro";
    rerender(<ChatInputToolbar {...defaultProps} />);
    expect(
      screen.queryByTestId("free-ask-computer-activation"),
    ).not.toBeInTheDocument();
  });

  it("hides computer activation for logged-out users and while access resolves", () => {
    const { rerender } = render(<ChatInputToolbar {...defaultProps} />);
    expect(
      screen.queryByTestId("free-ask-computer-activation"),
    ).not.toBeInTheDocument();

    mockAuthUser({ id: "user_123" });
    mockChatModeAccessResolved = false;
    rerender(<ChatInputToolbar {...defaultProps} />);
    expect(
      screen.queryByTestId("free-ask-computer-activation"),
    ).not.toBeInTheDocument();
  });

  it("shows desktop permission and sandbox selectors only in agent mode", () => {
    mockAuthUser({ id: "user_123" });

    const { rerender } = render(
      <ChatInputToolbar {...defaultProps} chatMode="ask" />,
    );
    expect(
      screen.queryByTestId("agent-permission-selector"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("sandbox-selector")).not.toBeInTheDocument();

    rerender(<ChatInputToolbar {...defaultProps} chatMode="agent" />);
    expect(screen.getAllByTestId("agent-permission-selector")).toHaveLength(2);
    const desktopSandbox = within(
      screen.getByTestId("chat-input-desktop-sandbox"),
    ).getByTestId("sandbox-selector");
    expect(desktopSandbox).toBeInTheDocument();
    expect(desktopSandbox).toHaveAttribute("data-size", "toolbar");
    expect(desktopSandbox).toHaveAttribute("data-value", "e2b");
    fireEvent.click(desktopSandbox);
    expect(mockSetSandboxPreference).toHaveBeenCalledWith("local");
    expect(screen.getByTestId("chat-input-desktop-permission")).toHaveClass(
      "hidden",
      "md:block",
    );
    expect(screen.getByTestId("chat-input-desktop-sandbox")).toHaveClass(
      "hidden",
      "min-w-16",
      "md:block",
    );
  });

  it("keeps model and send actions outside the flexible toolbar controls", () => {
    mockAuthUser({ id: "user_123" });

    render(<ChatInputToolbar {...defaultProps} chatMode="agent" />);

    expect(screen.getByTestId("chat-input-toolbar-controls")).toHaveClass(
      "min-w-0",
      "flex-1",
      "overflow-hidden",
      "md:flex-wrap",
    );
    expect(screen.getByTestId("chat-input-primary-actions")).toHaveClass(
      "shrink-0",
    );
    expect(screen.getByTestId("chat-input-primary-actions")).toContainElement(
      screen.getByTestId("model-selector"),
    );
    expect(screen.getByTestId("chat-input-primary-actions")).toContainElement(
      screen.getByRole("button", { name: "Send" }),
    );
  });

  it("removes only the mode selector for paid Agent-only mode", () => {
    mockAuthUser({ id: "user_123" });
    mockSubscription = "pro";
    mockPaidAgentOnlyActive = true;

    render(<ChatInputToolbar {...defaultProps} chatMode="agent" />);

    expect(screen.queryByTestId("chat-mode-selector")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("agent-permission-selector")).toHaveLength(2);
  });

  it("removes only the mode selector for free Desktop Agent-only mode", () => {
    mockAuthUser({ id: "user_123" });
    mockFreeDesktopAgentOnlyActive = true;

    render(<ChatInputToolbar {...defaultProps} chatMode="agent" />);

    expect(screen.queryByTestId("chat-mode-selector")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("agent-permission-selector")).toHaveLength(2);
    expect(screen.getByTestId("model-selector")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute(
      "data-neutral-agent-style",
      "true",
    );
  });

  it("never flashes the mode selector while paid access resolves", () => {
    mockAuthUser({ id: "user_123" });
    mockChatModeAccessResolved = false;

    const { rerender } = render(<ChatInputToolbar {...defaultProps} />);

    expect(screen.queryByTestId("chat-mode-selector")).not.toBeInTheDocument();

    mockSubscription = "pro";
    mockChatModeAccessResolved = true;
    mockPaidAgentOnlyActive = true;
    rerender(<ChatInputToolbar {...defaultProps} chatMode="agent" />);

    expect(screen.queryByTestId("chat-mode-selector")).not.toBeInTheDocument();
  });

  it("shows the mode selector after access resolves for eligible users", () => {
    mockAuthUser({ id: "user_123" });

    render(<ChatInputToolbar {...defaultProps} />);

    expect(screen.getByTestId("chat-mode-selector")).toBeInTheDocument();
  });

  it("enables the paid visual treatment only for paid subscriptions", () => {
    const { rerender } = render(<ChatInputToolbar {...defaultProps} />);

    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute(
      "data-is-paid",
      "false",
    );

    mockSubscription = "pro";
    rerender(<ChatInputToolbar {...defaultProps} />);

    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute(
      "data-is-paid",
      "true",
    );
  });
});
