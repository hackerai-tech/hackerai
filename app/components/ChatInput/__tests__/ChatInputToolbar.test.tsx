import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import type { SubscriptionTier } from "@/types";

let mockSubscription: SubscriptionTier = "free";
let mockHac45AgentOnlyActive = false;

jest.mock("@/app/components/AttachmentButton", () => ({
  AttachmentButton: () => <button type="button">Attach</button>,
}));

jest.mock("../ChatModeSelector", () => ({
  ChatModeSelector: () => <div data-testid="chat-mode-selector" />,
}));

jest.mock("@/app/components/ModelSelector", () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));

jest.mock("@/app/components/AgentPermissionSelector", () => ({
  AgentPermissionSelector: () => (
    <div data-testid="agent-permission-selector" />
  ),
}));

jest.mock("../SubmitStopButton", () => ({
  SubmitStopButton: ({ isPaid }: { isPaid?: boolean }) => (
    <button type="button" data-is-paid={String(isPaid)}>
      Send
    </button>
  ),
}));

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    selectedModel: "auto",
    setSelectedModel: jest.fn(),
    subscription: mockSubscription,
  }),
}));

jest.mock("@/app/contexts/Hac45AgentOnlyContext", () => ({
  useHac45AgentOnlyTreatment: () => mockHac45AgentOnlyActive,
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
    mockHac45AgentOnlyActive = false;
    mockAuthUser(null);
  });

  it("hides the model selector for logged-out users", () => {
    render(<ChatInputToolbar {...defaultProps} />);

    expect(screen.getByTestId("chat-mode-selector")).toBeInTheDocument();
    expect(screen.queryByTestId("model-selector")).not.toBeInTheDocument();
  });

  it("shows the model selector for logged-in users", () => {
    mockAuthUser({ id: "user_123" });

    render(<ChatInputToolbar {...defaultProps} />);

    expect(screen.getByTestId("model-selector")).toBeInTheDocument();
  });

  it("shows the permission selector only in agent mode", () => {
    mockAuthUser({ id: "user_123" });

    const { rerender } = render(
      <ChatInputToolbar {...defaultProps} chatMode="ask" />,
    );
    expect(
      screen.queryByTestId("agent-permission-selector"),
    ).not.toBeInTheDocument();

    rerender(<ChatInputToolbar {...defaultProps} chatMode="agent" />);
    expect(screen.getByTestId("agent-permission-selector")).toBeInTheDocument();
  });

  it("removes mode and permission selectors for the HAC-45 treatment", () => {
    mockAuthUser({ id: "user_123" });
    mockHac45AgentOnlyActive = true;

    render(<ChatInputToolbar {...defaultProps} chatMode="agent" />);

    expect(screen.queryByTestId("chat-mode-selector")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-permission-selector"),
    ).not.toBeInTheDocument();
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
