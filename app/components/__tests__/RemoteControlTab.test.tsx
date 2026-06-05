import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
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
let mockTemporaryChatsEnabled: boolean;

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

jest.mock("convex/react", () => ({
  useMutation: jest.fn(() => jest.fn()),
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
    temporaryChatsEnabled: mockTemporaryChatsEnabled,
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

describe("RemoteControlTab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnections = [];
    mockChatMode = "ask";
    mockSubscription = "free";
    mockSandboxPreference = "e2b";
    mockSelectedModel = "hackerai-pro";
    mockTemporaryChatsEnabled = false;
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
});
