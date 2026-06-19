import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { useAuth } from "@workos-inc/authkit-nextjs/components";

jest.mock("@/app/components/AttachmentButton", () => ({
  AttachmentButton: () => <button type="button">Attach</button>,
}));

jest.mock("../ChatModeSelector", () => ({
  ChatModeSelector: () => <div data-testid="chat-mode-selector" />,
}));

jest.mock("@/app/components/ModelSelector", () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));

jest.mock("../SubmitStopButton", () => ({
  SubmitStopButton: () => <button type="button">Send</button>,
}));

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    selectedModel: "auto",
    setSelectedModel: jest.fn(),
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
});
