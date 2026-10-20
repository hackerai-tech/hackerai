import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { BrowserHandoffEntry } from "../BrowserHandoffEntry";

let mockSession: { state: string } | null;
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
  mockSession = { state: "agent" };
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
