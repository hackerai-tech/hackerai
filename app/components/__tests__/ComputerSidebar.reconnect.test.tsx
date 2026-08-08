import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { SidebarContent } from "@/types/chat";

const mockUseQuery = jest.fn<any>();
const mockOpenSidebar = jest.fn();
const mockCloseSidebar = jest.fn();
const mockRetrySubagentRealtime = jest.fn();
let mockSubagentRealtime = {
  message: null,
  state: "idle",
  retry: mockRetrySubagentRealtime,
};
let mockSidebarContent: SidebarContent | null = null;

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const DynamicComponent = () => <div data-testid="dynamic-component" />;
    return DynamicComponent;
  },
}));

jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img {...props} alt={props.alt || ""} />
  ),
}));

jest.mock("convex/react", () => ({
  useAction: () => jest.fn(),
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

jest.mock("@/convex/_generated/api", () => ({
  api: {
    subagents: {
      getOwned: "getOwned",
      getMessagesOwned: "getMessagesOwned",
    },
  },
}));

jest.mock("@/app/hooks/useSubagentRealtime", () => ({
  useSubagentRealtime: () => mockSubagentRealtime,
}));

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    sidebarOpen: mockSidebarContent !== null,
    sidebarContent: mockSidebarContent,
    closeSidebar: mockCloseSidebar,
    openSidebar: mockOpenSidebar,
  }),
}));

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

jest.mock("@/components/ui/code-action-buttons", () => ({
  CodeActionButtons: () => <div data-testid="code-action-buttons" />,
}));

jest.mock("../ComputerCodeBlock", () => ({
  ComputerCodeBlock: ({ children }: { children: React.ReactNode }) => (
    <pre data-testid="computer-code-block">{children}</pre>
  ),
}));

jest.mock("../TerminalCodeBlock", () => ({
  TerminalCodeBlock: ({ command }: { command: string }) => (
    <pre data-testid="terminal-code-block">{command}</pre>
  ),
}));

jest.mock("../TodoPanel", () => ({
  TodoPanel: () => <div data-testid="todo-panel" />,
}));

const { ComputerSidebar, ComputerSidebarBase } =
  require("../ComputerSidebar") as typeof import("../ComputerSidebar");

const activeSidebarContent: SidebarContent = {
  command: "npm test",
  output: "",
  isExecuting: true,
  toolCallId: "tool-active",
};

const otherToolMessage = {
  id: "assistant-1",
  role: "assistant",
  parts: [
    {
      type: "tool-run_terminal_cmd",
      toolCallId: "tool-other",
      state: "output-available",
      input: { command: "pwd" },
      output: { result: { output: "/tmp\n" } },
    },
  ],
};

describe("ComputerSidebar reconnect behavior", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockUseQuery.mockReset();
    mockUseQuery.mockReturnValue(undefined);
    mockSubagentRealtime = {
      message: null,
      state: "idle",
      retry: mockRetrySubagentRealtime,
    };
    mockSidebarContent = null;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("does not close or jump while streaming replay temporarily misses active content", () => {
    const closeSidebar = jest.fn();
    const onNavigate = jest.fn();

    render(
      <ComputerSidebarBase
        sidebarOpen
        sidebarContent={activeSidebarContent}
        closeSidebar={closeSidebar}
        messages={[otherToolMessage]}
        onNavigate={onNavigate}
        status="streaming"
      />,
    );

    expect(screen.getByTestId("terminal-code-block")).toHaveTextContent(
      "npm test",
    );

    act(() => {
      jest.advanceTimersByTime(6_000);
    });

    expect(closeSidebar).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("waits before navigating away from genuinely missing content", () => {
    const closeSidebar = jest.fn();
    const onNavigate = jest.fn();

    render(
      <ComputerSidebarBase
        sidebarOpen
        sidebarContent={activeSidebarContent}
        closeSidebar={closeSidebar}
        messages={[otherToolMessage]}
        onNavigate={onNavigate}
        status="ready"
      />,
    );

    act(() => {
      jest.advanceTimersByTime(4_999);
    });

    expect(closeSidebar).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(closeSidebar).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "tool-other" }),
    );
  });

  it("returns to the subagent and navigates the supplied child-tool timeline", () => {
    const closeSidebar = jest.fn();
    const onNavigate = jest.fn();
    const onBack = jest.fn();
    const childToolMessages = [
      {
        id: "subagent-assistant",
        role: "assistant",
        parts: [
          {
            type: "tool-run_terminal_cmd",
            toolCallId: "child-tool-1",
            state: "output-available",
            input: { command: "pwd" },
            output: { result: { output: "/tmp\n" } },
          },
          {
            type: "tool-run_terminal_cmd",
            toolCallId: "child-tool-2",
            state: "output-available",
            input: { command: "npm test" },
            output: { result: { output: "passed\n" } },
          },
        ],
      },
    ];

    render(
      <ComputerSidebarBase
        sidebarOpen
        sidebarContent={{
          command: "npm test",
          output: "passed\n",
          isExecuting: false,
          toolCallId: "child-tool-2",
        }}
        closeSidebar={closeSidebar}
        messages={childToolMessages}
        onNavigate={onNavigate}
        status="ready"
        backNavigation={{ label: "Back to subagent", onBack }}
      />,
    );

    expect(
      screen.getByRole("slider", { name: "Tool execution 2 of 2" }),
    ).toHaveAttribute("aria-valuenow", "1");

    fireEvent.click(
      screen.getByRole("button", { name: "Previous tool execution" }),
    );
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "child-tool-1" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to subagent" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("uses the owned subagent transcript for wrapper navigation", () => {
    const origin = {
      kind: "subagent" as const,
      subagentId: "sa_child",
      returnContent: {
        kind: "subagents" as const,
        parentMessageId: "parent-message",
        toolCallId: "delegate-tool",
        selectedSubagentId: "sa_child",
      },
    };
    mockSidebarContent = {
      command: "npm test",
      output: "passed\n",
      isExecuting: false,
      toolCallId: "child-tool-2",
      origin,
    };
    mockUseQuery.mockImplementation((query) => {
      if (query === "getOwned") {
        return {
          subagent_id: "sa_child",
          status: "completed",
          trigger_run_id: "run-child",
        };
      }
      return [
        {
          message_id: "child-message",
          sequence: 1,
          role: "assistant",
          parts: [
            {
              type: "tool-run_terminal_cmd",
              toolCallId: "child-tool-1",
              state: "output-available",
              input: { command: "pwd" },
              output: { result: { output: "/tmp\n" } },
            },
            {
              type: "tool-run_terminal_cmd",
              toolCallId: "child-tool-2",
              state: "output-available",
              input: { command: "npm test" },
              output: { result: { output: "passed\n" } },
            },
          ],
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ];
    });

    render(<ComputerSidebar messages={[otherToolMessage]} status="ready" />);

    expect(
      screen.getByRole("slider", { name: "Tool execution 2 of 2" }),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Previous tool execution" }),
    );
    expect(mockOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "child-tool-1",
        origin,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to subagent" }));
    expect(mockOpenSidebar).toHaveBeenCalledWith(origin.returnContent);
  });

  it("offers reconnect when an active child stream fails before persistence", () => {
    const origin = {
      kind: "subagent" as const,
      subagentId: "sa_child",
      returnContent: {
        kind: "subagents" as const,
        parentMessageId: "parent-message",
        toolCallId: "delegate-tool",
        selectedSubagentId: "sa_child",
      },
    };
    mockSidebarContent = {
      command: "npm test",
      output: "",
      isExecuting: true,
      toolCallId: "child-tool-1",
      origin,
    };
    mockUseQuery.mockImplementation((query) =>
      query === "getOwned"
        ? {
            subagent_id: "sa_child",
            status: "running",
            trigger_run_id: "run-child",
          }
        : [],
    );
    mockSubagentRealtime = {
      message: null,
      state: "error",
      retry: mockRetrySubagentRealtime,
    };

    render(<ComputerSidebar messages={[]} status="streaming" />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Live updates disconnected.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(mockRetrySubagentRealtime).toHaveBeenCalledTimes(1);
  });
});
