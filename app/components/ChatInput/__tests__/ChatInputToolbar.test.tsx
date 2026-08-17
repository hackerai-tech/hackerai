import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import type { SubscriptionTier } from "@/types";

let mockSubscription: SubscriptionTier = "free";
let mockChatModeAccessResolved = true;
let mockPaidAgentOnlyActive = false;
let mockFreeDesktopAgentOnlyActive = false;
let mockHasLocalSandbox = false;
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
    sandboxPreference: "e2b",
    setSandboxPreference: mockSetSandboxPreference,
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
    mockSetSandboxPreference.mockClear();
    mockAuthUser(null);
  });

  it("hides the mode and model selectors for logged-out users", () => {
    render(<ChatInputToolbar {...defaultProps} />);

    expect(screen.queryByTestId("chat-mode-selector")).not.toBeInTheDocument();
    expect(screen.queryByTestId("model-selector")).not.toBeInTheDocument();
  });

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
    expect(screen.getByTestId("agent-permission-selector")).toBeInTheDocument();
    expect(screen.getByTestId("sandbox-selector")).toBeInTheDocument();
    expect(screen.getByTestId("sandbox-selector")).toHaveAttribute(
      "data-size",
      "toolbar",
    );
    expect(screen.getByTestId("sandbox-selector")).toHaveAttribute(
      "data-value",
      "e2b",
    );
    fireEvent.click(screen.getByTestId("sandbox-selector"));
    expect(mockSetSandboxPreference).toHaveBeenCalledWith("local");
    expect(screen.getByTestId("chat-input-desktop-permission")).toHaveClass(
      "hidden",
      "md:block",
    );
    expect(screen.getByTestId("chat-input-desktop-sandbox")).toHaveClass(
      "hidden",
      "md:block",
    );
  });

  it("removes only the mode selector for paid Agent-only mode", () => {
    mockAuthUser({ id: "user_123" });
    mockSubscription = "pro";
    mockPaidAgentOnlyActive = true;

    render(<ChatInputToolbar {...defaultProps} chatMode="agent" />);

    expect(screen.queryByTestId("chat-mode-selector")).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-permission-selector")).toBeInTheDocument();
  });

  it("removes only the mode selector for free Desktop Agent-only mode", () => {
    mockAuthUser({ id: "user_123" });
    mockFreeDesktopAgentOnlyActive = true;

    render(<ChatInputToolbar {...defaultProps} chatMode="agent" />);

    expect(screen.queryByTestId("chat-mode-selector")).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-permission-selector")).toBeInTheDocument();
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
