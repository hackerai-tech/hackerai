import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

type MockConnection = {
  connectionId: string;
  name: string;
  osInfo?: {
    platform: string;
    arch: string;
    release: string;
    hostname: string;
  };
  lastSeen: number;
  isDesktop: boolean;
};

let mockConnections: MockConnection[] | undefined;
let mockChatMode: "ask" | "agent";
let mockSubscription: "free" | "pro";
let mockSandboxPreference: string;
let mockSelectedModel: "auto" | "hackerai-standard" | "hackerai-pro";

const mockGetToken = jest.fn<() => Promise<{ token: string }>>();
const mockRegenerateToken = jest.fn<() => Promise<{ token: string }>>();
const mockWriteText = jest.fn<(text: string) => Promise<void>>();
const mockSetChatMode = jest.fn((mode: "ask" | "agent") => {
  mockChatMode = mode;
});
const mockSetSandboxPreference = jest.fn((preference: string) => {
  mockSandboxPreference = preference;
});
const mockSetSelectedModel = jest.fn(
  (model: "auto" | "hackerai-standard" | "hackerai-pro") => {
    mockSelectedModel = model;
  },
);

jest.mock("@/convex/_generated/api", () => ({
  api: {
    localSandbox: {
      getToken: "getToken",
      regenerateToken: "regenerateToken",
    },
  },
}));

jest.mock("convex/react", () => ({
  useMutation: jest.fn((mutation: string) =>
    mutation === "getToken" ? mockGetToken : mockRegenerateToken,
  ),
}));

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    chatMode: mockChatMode,
    setChatMode: mockSetChatMode,
    subscription: mockSubscription,
    sandboxPreference: mockSandboxPreference,
    setSandboxPreference: mockSetSandboxPreference,
    selectedModel: mockSelectedModel,
    setSelectedModel: mockSetSelectedModel,
    localConnections: mockConnections,
  }),
}));

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

const { RemoteControlTab } = jest.requireActual<
  typeof import("../RemoteControlTab")
>("../RemoteControlTab");
const { toast } = jest.requireMock<typeof import("sonner")>("sonner");

const remoteConnection: MockConnection = {
  connectionId: "conn-remote-1",
  name: "My Machine",
  osInfo: {
    platform: "darwin",
    arch: "arm64",
    release: "25.0.0",
    hostname: "devbox",
  },
  lastSeen: 123,
  isDesktop: false,
};

const desktopConnection: MockConnection = {
  connectionId: "conn-desktop-1",
  name: "HackerAI Desktop",
  osInfo: {
    platform: "darwin",
    arch: "arm64",
    release: "25.0.0",
    hostname: "bobbys-mac",
  },
  lastSeen: 123,
  isDesktop: true,
};

describe("RemoteControlTab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnections = [];
    mockChatMode = "ask";
    mockSubscription = "free";
    mockSandboxPreference = "e2b";
    mockSelectedModel = "hackerai-pro";
    mockGetToken.mockResolvedValue({ token: "test-token" });
    mockRegenerateToken.mockResolvedValue({ token: "regenerated-token" });
    mockWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mockWriteText },
    });
  });

  it("selects agent mode with the new local connection after an empty baseline", async () => {
    const { rerender } = render(<RemoteControlTab />);

    expect(mockSetChatMode).not.toHaveBeenCalled();
    expect(screen.getByText("No active connections")).toBeInTheDocument();

    mockConnections = [remoteConnection];
    rerender(<RemoteControlTab />);

    await waitFor(() => {
      expect(mockSetSandboxPreference).toHaveBeenCalledWith("conn-remote-1");
    });
    expect(mockSetSelectedModel).toHaveBeenCalledWith("auto");
    expect(mockSetChatMode).toHaveBeenCalledWith("agent");
    expect(toast.success).toHaveBeenCalledWith(
      "Local sandbox connected. Switched to Agent mode.",
    );
  });

  it("does not switch modes when an existing connection appears on initial query load", async () => {
    mockConnections = undefined;
    const { rerender } = render(<RemoteControlTab />);

    mockConnections = [remoteConnection];
    rerender(<RemoteControlTab />);

    await waitFor(() => {
      expect(screen.getByText("devbox")).toBeInTheDocument();
    });
    expect(mockSetSandboxPreference).not.toHaveBeenCalled();
    expect(mockSetSelectedModel).not.toHaveBeenCalled();
    expect(mockSetChatMode).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("shows a desktop bridge as an active connection", () => {
    mockConnections = [desktopConnection];

    render(<RemoteControlTab />);

    expect(screen.getByText("bobbys-mac")).toBeInTheDocument();
    expect(screen.getByText("Desktop app connected")).toBeInTheDocument();
    expect(screen.queryByText("No active connections")).not.toBeInTheDocument();
  });

  it("generates a token and copies a ready-to-run command in one action", async () => {
    render(<RemoteControlTab />);

    fireEvent.click(
      screen.getByRole("button", { name: "Copy connect command" }),
    );

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith(
        expect.stringContaining("--token test-token"),
      );
    });
    expect(mockGetToken).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(
      "Connect command copied. Paste it into your terminal.",
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reuses the generated token when the command is copied again", async () => {
    render(<RemoteControlTab />);

    const copyButton = screen.getByRole("button", {
      name: "Copy connect command",
    });
    fireEvent.click(copyButton);
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledTimes(1));

    fireEvent.click(copyButton);
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledTimes(2));

    expect(mockGetToken).toHaveBeenCalledTimes(1);
    expect(mockWriteText).toHaveBeenLastCalledWith(
      expect.stringContaining("--token test-token"),
    );
  });

  it("handles a rejected clipboard write without a false success", async () => {
    mockWriteText.mockRejectedValue(
      new DOMException("Document is not focused"),
    );
    render(<RemoteControlTab />);

    fireEvent.click(
      screen.getByRole("button", { name: "Copy connect command" }),
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Failed to copy connect command",
      );
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("does not copy a placeholder command when token generation fails", async () => {
    mockGetToken.mockRejectedValue(new Error("Token service unavailable"));
    render(<RemoteControlTab />);

    fireEvent.click(
      screen.getByRole("button", { name: "Copy connect command" }),
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Failed to copy connect command",
      );
    });
    expect(mockWriteText).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
