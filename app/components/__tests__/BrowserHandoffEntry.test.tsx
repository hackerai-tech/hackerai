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

it("opens the latest browser tool without claiming the running Agent is paused", () => {
  render(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Agent browser available",
  );
  fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
  expect(mockOpenSidebar).toHaveBeenCalledWith(
    expect.objectContaining({
      toolCallId: "current-browser",
      command: "agent-browser snapshot -i",
    }),
  );
});

it("shows recovery as paused and removes the entry when the session ends", () => {
  mockSession = { state: "recovery" };
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Agent paused");
  mockSession = null;
  view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("does not duplicate the entry while the Computer panel is open", () => {
  mockSidebarOpen = true;
  render(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("distinguishes a requested handoff from an Agent still working", () => {
  mockSession = { state: "waiting" };
  render(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for you");
  expect(screen.getByRole("button", { name: "Open browser" })).toBeEnabled();
});

it("keeps the reminder hidden after opening, closing the panel, and reloading", () => {
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  mockSidebarOpen = true;
  view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  mockSidebarOpen = false;
  view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  view.unmount();
  render(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("dismisses without opening and does not repeat in another chat", () => {
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Hide browser reminder" }),
  );
  expect(mockOpenSidebar).not.toHaveBeenCalled();
  mockSession = { state: "agent", sessionId: "replacement", updatedAt: 50 };
  view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  view.rerender(<BrowserHandoffEntry chatId="other" messages={messages} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("shows passive discovery only once even if it was not clicked", () => {
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Agent browser available",
  );
  expect(localStorage.getItem("browser-reminder:discovered:v1")).toBe("true");
  view.rerender(<BrowserHandoffEntry chatId="other" messages={messages} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  view.unmount();
  render(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("still surfaces an explicit handoff in a later chat", () => {
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  mockSession = { state: "waiting", sessionId: "new-session", updatedAt: 2 };
  view.rerender(<BrowserHandoffEntry chatId="other" messages={messages} />);
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for you");
});

it("surfaces new handoff requests but keeps an acknowledged request hidden on reload", () => {
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Hide browser reminder" }),
  );
  mockSession = { state: "waiting", sessionId: "session", updatedAt: 2 };
  view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for you");
  fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
  view.unmount();
  const reloaded = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  mockSession = { ...mockSession, updatedAt: 3 };
  reloaded.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for you");
});

it("still opens and hides the reminder when browser storage is blocked", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
    expect(mockOpenSidebar).toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  } finally {
    get.mockRestore();
    set.mockRestore();
  }
});

it("recovers from malformed preferences and syncs dismissal from another tab", () => {
  localStorage.setItem("browser-reminder:v1:chat", "{invalid");
  render(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Agent browser available",
  );
  localStorage.setItem(
    "browser-reminder:v1:chat",
    JSON.stringify({ availableHidden: true }),
  );
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", { key: "browser-reminder:v1:chat" }),
    ),
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("keeps discovery hidden when a chat preference is malformed", () => {
  localStorage.setItem("browser-reminder:discovered:v1", "true");
  localStorage.setItem("browser-reminder:v1:chat", "{invalid");
  render(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it.each(["availableHidden", "browserDiscovered"])(
  "migrates a saved %s preference across chats",
  (field) => {
    localStorage.setItem(
      "browser-reminder:v1:chat",
      JSON.stringify({ [field]: true }),
    );
    const view = render(
      <BrowserHandoffEntry chatId="chat" messages={messages} />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(localStorage.getItem("browser-reminder:discovered:v1")).toBe("true");
    view.rerender(<BrowserHandoffEntry chatId="other" messages={messages} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  },
);

it("keeps acknowledged takeover transitions quiet while surfacing recovery", () => {
  mockSession = { state: "waiting", sessionId: "session", updatedAt: 2 };
  const view = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
  for (const state of ["claiming", "human", "resuming", "agent"]) {
    mockSidebarOpen = true;
    mockSession = { state, sessionId: "session", updatedAt: 3 };
    view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
    mockSidebarOpen = false;
    view.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  }
  view.unmount();
  mockSession = { state: "human", sessionId: "session", updatedAt: 4 };
  const reloaded = render(
    <BrowserHandoffEntry chatId="chat" messages={messages} />,
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  mockSession = { state: "recovery", sessionId: "session", updatedAt: 4 };
  reloaded.rerender(<BrowserHandoffEntry chatId="chat" messages={messages} />);
  expect(screen.getByRole("status")).toHaveTextContent("Agent paused");
});
