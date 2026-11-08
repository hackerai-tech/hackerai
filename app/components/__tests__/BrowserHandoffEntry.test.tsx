import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { BrowserHandoffEntry } from "../BrowserHandoffEntry";

let mockSession: {
  state: string;
  sessionId?: string;
  updatedAt?: number;
  grantExpiresAt?: number | null;
  expiresAt?: number;
} | null;
let mockSidebarOpen = false;
let mockSidebarContent: { kind: string } | null = null;
const mockOpenSidebar = jest.fn();
jest.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: () => mockSession,
}));
jest.mock("@/convex/_generated/api", () => ({
  api: { browserHandoffs: { getForUser: "getForUser" } },
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    sidebarOpen: mockSidebarOpen,
    sidebarContent: mockSidebarContent,
    openSidebar: mockOpenSidebar,
  }),
}));

const messages = [
  {
    role: "assistant",
    parts: [
      {
        type: "tool-shell",
        toolCallId: "old-browser",
        state: "input-available",
        input: {
          action: "exec",
          command: "agent-browser open https://example.com",
        },
      },
      {
        type: "tool-shell",
        toolCallId: "current-browser",
        state: "input-available",
        input: { action: "exec", command: "agent-browser snapshot -i" },
      },
      {
        type: "tool-shell",
        toolCallId: "other-command",
        state: "input-available",
        input: { action: "exec", command: "ls" },
      },
    ],
  },
];

beforeEach(() => {
  localStorage.clear();
  mockSession = { state: "agent", sessionId: "session", updatedAt: 1 };
  mockSidebarOpen = false;
  mockSidebarContent = null;
  mockOpenSidebar.mockClear();
});

it("keeps normal browsing quiet across chats, reloads and legacy dismissals", () => {
  localStorage.setItem("browser-reminder:discovered:v1", "true");
  localStorage.setItem(
    "browser-reminder:v1:chat",
    JSON.stringify({ availableHidden: true, browserDiscovered: true }),
  );
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  for (const state of ["agent", "claiming", "human", "resuming"]) {
    mockSession = {
      state,
      sessionId: "session",
      updatedAt: Date.now(),
      grantExpiresAt: Date.now() + 30_000,
    };
    view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  }
  view.rerender(<BrowserHandoffEntry chatId="other" messages={messages} />);
  expect(screen.queryByRole("button")).toBeNull();
  view.unmount();
  render(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(mockOpenSidebar).not.toHaveBeenCalled();
});

it("requests takeover of the exact waiting session only after the user clicks", () => {
  mockSession = { state: "waiting", sessionId: "session", updatedAt: 2 };
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Agent needs your input",
  );
  expect(mockOpenSidebar).not.toHaveBeenCalled();
  mockSidebarOpen = true;
  view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.queryByRole("button")).toBeNull();
  mockSidebarOpen = false;
  view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  fireEvent.click(screen.getByRole("button", { name: "Take control" }));
  expect(mockOpenSidebar).toHaveBeenCalledWith(
    expect.objectContaining({
      toolCallId: "current-browser",
      browserTakeoverRequest: {
        sessionId: "session",
        requestId: expect.any(String),
      },
    }),
  );
});

it("hides dismissed attention across reloads and surfaces a new request", () => {
  mockSession = { state: "waiting", sessionId: "session", updatedAt: 2 };
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss browser takeover prompt" }),
  );
  expect(mockOpenSidebar).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  view.unmount();
  const reloaded = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  mockSession = { ...mockSession, updatedAt: 3 };
  reloaded.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.getByRole("button", { name: "Take control" })).toBeEnabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss browser takeover prompt" }),
  );
  mockSession = { state: "waiting", sessionId: "new-session", updatedAt: 3 };
  reloaded.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Agent needs your input",
  );
});

it("surfaces recovery after a dismissed wait and keeps takeover transitions quiet", () => {
  mockSession = { state: "waiting", sessionId: "session", updatedAt: 2 };
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss browser takeover prompt" }),
  );
  for (const state of ["claiming", "human", "resuming", "agent"]) {
    mockSession = {
      state,
      sessionId: "session",
      updatedAt: Date.now(),
      grantExpiresAt: Date.now() + 30_000,
    };
    view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  }
  mockSession = { state: "recovery", sessionId: "session", updatedAt: 4 };
  view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Browser takeover needs attention",
  );
});

it("shows no prompt without an active browser session or browser tool", () => {
  mockSession = null;
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  mockSession = { state: "waiting", sessionId: "session" };
  view.rerender(<BrowserHandoffEntry chatId="chat" messages={[]} />);
  expect(screen.queryByRole("button")).toBeNull();
});

it("allows takeover and dismissal when browser storage is blocked", () => {
  mockSession = { state: "waiting", sessionId: "session", updatedAt: 2 };
  const get = jest
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(() => {
      throw new Error("blocked");
    });
  const set = jest
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("blocked");
    });
  try {
    render(<BrowserHandoffEntry chatId="chat" messages={messages} />);
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(mockOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({
        browserTakeoverRequest: expect.objectContaining({
          sessionId: "session",
        }),
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss browser takeover prompt" }),
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  } finally {
    get.mockRestore();
    set.mockRestore();
  }
});

it("recovers from malformed preferences and syncs attention dismissal from another tab", () => {
  mockSession = { state: "waiting", sessionId: "session", updatedAt: 2 };
  localStorage.setItem("browser-reminder:v1:chat", "{invalid");
  render(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.getByRole("button", { name: "Take control" })).toBeEnabled();
  localStorage.setItem(
    "browser-reminder:v1:chat",
    JSON.stringify({ dismissedAttention: "session:waiting:2" }),
  );
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", { key: "browser-reminder:v1:chat" }),
    ),
  );
  expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});

// The Goal editor occupies the sidebar instead of the browser preview.
it("keeps takeover reachable while the Goal editor is open", () => {
  mockSession = { state: "waiting", sessionId: "session", updatedAt: 2 };
  mockSidebarOpen = true;
  mockSidebarContent = { kind: "goal" };
  render(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  fireEvent.click(screen.getByRole("button", { name: "Take control" }));
  expect(mockOpenSidebar).toHaveBeenCalledWith(
    expect.objectContaining({
      toolCallId: "current-browser",
      browserTakeoverRequest: expect.objectContaining({ sessionId: "session" }),
    }),
  );
});

it("keeps persisted takeover reachable when the live message stream has not caught up", () => {
  mockSession = {
    state: "waiting",
    sessionId: "persisted-session",
    updatedAt: 9,
  };
  render(
    <BrowserHandoffEntry
      chatId="chat"
      messages={[]}
      persistedMessages={messages}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Agent needs your input",
  );
  expect(mockOpenSidebar).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Take control" }));
  expect(mockOpenSidebar).toHaveBeenCalledWith(
    expect.objectContaining({
      toolCallId: "current-browser",
      browserTakeoverRequest: {
        sessionId: "persisted-session",
        requestId: expect.any(String),
      },
    }),
  );
});

it("prefers live browser progress over an older persisted browser command", () => {
  mockSession = { state: "waiting", sessionId: "session", updatedAt: 10 };
  const liveMessages = [
    {
      role: "assistant",
      parts: [
        {
          type: "tool-shell",
          toolCallId: "live-browser",
          state: "input-available",
          input: { action: "exec", command: "agent-browser screenshot" },
        },
      ],
    },
  ];
  render(
    <BrowserHandoffEntry
      chatId="chat"
      messages={liveMessages}
      persistedMessages={messages}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Take control" }));
  expect(mockOpenSidebar).toHaveBeenCalledWith(
    expect.objectContaining({ toolCallId: "live-browser" }),
  );
});

it.each(["human", "claiming", "resuming"])(
  "surfaces %s lease recovery after reload without a query update",
  (state) => {
    jest.useFakeTimers();
    jest.setSystemTime(100_000);
    mockSession = {
      state,
      sessionId: "paused-session",
      updatedAt: 90_000,
      grantExpiresAt: 120_000,
      expiresAt: 200_000,
    };
    const view = render(
      <BrowserHandoffEntry chatId="chat" messages={messages} />,
    );
    try {
      expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
      act(() => jest.advanceTimersByTime(20_001));
      fireEvent.click(screen.getByRole("button", { name: "Take control" }));
      expect(mockOpenSidebar).toHaveBeenCalledWith(
        expect.objectContaining({
          browserTakeoverRequest: expect.objectContaining({
            sessionId: "paused-session",
          }),
        }),
      );
      mockSession = null;
      view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
      expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    } finally {
      view.unmount();
      jest.useRealTimers();
    }
  },
);

it("reschedules renewed grants and retires an expired session without query updates", () => {
  jest.useFakeTimers();
  jest.setSystemTime(100_000);
  mockSession = {
    state: "human",
    sessionId: "session",
    updatedAt: 100_000,
    grantExpiresAt: 130_000,
    expiresAt: 160_000,
  };
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  try {
    act(() => jest.advanceTimersByTime(20_000));
    mockSession = {
      ...mockSession!,
      updatedAt: 120_000,
      grantExpiresAt: 150_000,
    };
    view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
    act(() => jest.advanceTimersByTime(15_000));
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    act(() => jest.advanceTimersByTime(15_000));
    expect(screen.getByRole("button", { name: "Take control" })).toBeEnabled();
    expect(mockOpenSidebar).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(10_000));
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  } finally {
    view.unmount();
    jest.useRealTimers();
  }
});
