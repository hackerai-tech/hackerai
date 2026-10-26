import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { BrowserHandoffEntry } from "../BrowserHandoffEntry";

let mockSession: {
  state: string;
  sessionId?: string;
  updatedAt?: number;
} | null;
let mockSidebarOpen = false;
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
  mockOpenSidebar.mockClear();
});

it("keeps compact access available across opens, chats, reloads and legacy dismissals", () => {
  localStorage.setItem("browser-reminder:discovered:v1", "true");
  localStorage.setItem(
    "browser-reminder:v1:chat",
    JSON.stringify({ availableHidden: true, browserDiscovered: true }),
  );
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open Agent browser" }));
  expect(mockOpenSidebar).toHaveBeenCalledWith(
    expect.objectContaining({ toolCallId: "current-browser" }),
  );
  expect(mockOpenSidebar.mock.calls[0][0]).not.toHaveProperty(
    "browserTakeoverRequest",
  );
  mockSidebarOpen = true;
  view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.queryByRole("button")).toBeNull();
  mockSidebarOpen = false;
  view.rerender(<BrowserHandoffEntry chatId="other" messages={messages} />);
  expect(
    screen.getByRole("button", { name: "Open Agent browser" }),
  ).toBeEnabled();
  view.unmount();
  render(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(
    screen.getByRole("button", { name: "Open Agent browser" }),
  ).toBeEnabled();
});

it("requests takeover of the exact waiting session only after the user clicks", () => {
  mockSession = { state: "waiting", sessionId: "session", updatedAt: 2 };
  render(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Agent needs your input",
  );
  expect(mockOpenSidebar).not.toHaveBeenCalled();
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

it("dismisses attention into compact access, preserves dismissal on reload, and surfaces a new request", () => {
  mockSession = { state: "waiting", sessionId: "session", updatedAt: 2 };
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss browser takeover prompt" }),
  );
  expect(mockOpenSidebar).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Open Agent browser" }),
  ).toBeEnabled();
  view.unmount();
  const reloaded = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  mockSession = { ...mockSession, updatedAt: 3 };
  reloaded.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.getByRole("button", { name: "Take control" })).toBeEnabled();
  mockSession = { state: "waiting", sessionId: "new-session", updatedAt: 3 };
  reloaded.rerender(<BrowserHandoffEntry chatId="other" messages={messages} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Agent needs your input",
  );
});

it("surfaces recovery after a dismissed wait and keeps takeover transitions compact", () => {
  mockSession = { state: "waiting", sessionId: "session", updatedAt: 2 };
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss browser takeover prompt" }),
  );
  for (const state of ["claiming", "human", "resuming", "agent"]) {
    mockSession = { state, sessionId: "session", updatedAt: 3 };
    view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open Agent browser" }),
    ).toBeEnabled();
  }
  mockSession = { state: "recovery", sessionId: "session", updatedAt: 4 };
  view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Browser takeover needs attention",
  );
});

it("shows neither access nor prompts without an active browser session or browser tool", () => {
  mockSession = null;
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  mockSession = { state: "waiting", sessionId: "session" };
  view.rerender(<BrowserHandoffEntry chatId="chat" messages={[]} />);
  expect(screen.queryByRole("button")).toBeNull();
});

it("allows dismissal and compact access when browser storage is blocked", () => {
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
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss browser takeover prompt" }),
    );
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Agent browser" }));
    expect(mockOpenSidebar).toHaveBeenCalled();
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
  expect(
    screen.getByRole("button", { name: "Open Agent browser" }),
  ).toBeEnabled();
});
