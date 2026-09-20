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
let mockSubagentRealtime: ReturnType<
  typeof import("@/app/hooks/useSubagentRealtime").useSubagentRealtime
> = {
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
  TerminalCodeBlock: ({
    command,
    output,
  }: {
    command: string;
    output?: string;
  }) => (
    <pre data-testid="terminal-code-block">
      {command}
      {"\n"}
      {output}
    </pre>
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

  it("pins a historical subagent command through replay until Jump to live", () => {
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
      command: "echo command-2",
      output: "selected output",
      isExecuting: false,
      toolCallId: "child-tool-2",
      origin,
    };
    mockUseQuery.mockImplementation((query) =>
      query === "getOwned"
        ? { status: "running", trigger_run_id: "run-child" }
        : [],
    );
    mockOpenSidebar.mockImplementation((content) => {
      mockSidebarContent = content as SidebarContent;
    });
    const { rerender } = render(<ComputerSidebar />);
    const replay = (count: number, selectedOutput = "updated output") => {
      mockSubagentRealtime = {
        ...mockSubagentRealtime,
        state: "live",
        message: {
          id: "child-message",
          role: "assistant",
          parts: Array.from({ length: count }, (_, index) => ({
            type: "tool-shell" as const,
            toolCallId: `child-tool-${index + 1}`,
            state: "output-available" as const,
            input: { action: "exec", command: `echo command-${index + 1}` },
            output: { output: index === 1 ? selectedOutput : "other output" },
          })),
        },
      };
      rerender(<ComputerSidebar />);
    };

    // A fresh subscription first replays commands older than the selected one.
    replay(1);
    expect(mockOpenSidebar).not.toHaveBeenCalled();
    expect(screen.getByTestId("terminal-code-block")).toHaveTextContent(
      "command-2",
    );
    replay(2);
    replay(3);
    replay(3, "new selected output");
    expect(mockOpenSidebar).not.toHaveBeenCalled();
    expect(screen.getByTestId("terminal-code-block")).toHaveTextContent(
      "command-2",
    );
    expect(screen.getByTestId("terminal-code-block")).toHaveTextContent(
      "new selected output",
    );

    fireEvent.click(screen.getByRole("button", { name: "Jump to live" }));
    rerender(<ComputerSidebar />);
    expect(screen.getByTestId("terminal-code-block")).toHaveTextContent(
      "command-3",
    );
    replay(4);
    rerender(<ComputerSidebar />);
    expect(screen.getByTestId("terminal-code-block")).toHaveTextContent(
      "command-4",
    );

    // Browsing back pins history, while returning to the latest command resumes
    // the same live-follow behavior as the normal Agent timeline.
    fireEvent.click(
      screen.getByRole("button", { name: "Previous tool execution" }),
    );
    rerender(<ComputerSidebar />);
    fireEvent.click(
      screen.getByRole("button", { name: "Next tool execution" }),
    );
    rerender(<ComputerSidebar />);
    mockOpenSidebar.mockClear();
    replay(5);
    expect(mockOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "child-tool-5" }),
    );
    rerender(<ComputerSidebar />);
    expect(screen.getByTestId("terminal-code-block")).toHaveTextContent(
      "command-5",
    );
  });

  it("follows the next subagent command when the latest selected command is complete", () => {
    const origin = {
      kind: "subagent" as const,
      subagentId: "sa_child",
      liveToolCallId: "child-tool-2",
      returnContent: {
        kind: "subagents" as const,
        parentMessageId: "parent-message",
        toolCallId: "delegate-tool",
        selectedSubagentId: "sa_child",
      },
    };
    mockSidebarContent = {
      command: "echo command-2",
      output: "selected output",
      isExecuting: false,
      toolCallId: "child-tool-2",
      origin,
    };
    mockUseQuery.mockImplementation((query) =>
      query === "getOwned"
        ? { status: "running", trigger_run_id: "run-child" }
        : [],
    );
    mockOpenSidebar.mockImplementation((content) => {
      mockSidebarContent = content as SidebarContent;
    });
    const { rerender } = render(<ComputerSidebar />);
    const replay = (count: number) => {
      mockSubagentRealtime = {
        ...mockSubagentRealtime,
        state: "live",
        message: {
          id: "child-message",
          role: "assistant",
          parts: Array.from({ length: count }, (_, index) => ({
            type: "tool-shell" as const,
            toolCallId: `child-tool-${index + 1}`,
            state: "output-available" as const,
            input: { action: "exec", command: `echo command-${index + 1}` },
            output: { output: "output" },
          })),
        },
      };
      rerender(<ComputerSidebar />);
    };

    // Replaying the prefix must not select an older command. Once a command
    // arrives after the selected live edge, the sidebar follows it.
    replay(1);
    replay(2);
    expect(mockOpenSidebar).not.toHaveBeenCalled();
    replay(3);
    expect(mockOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "child-tool-3" }),
    );
  });

  it("hands live following back to the parent after the subagent finishes", () => {
    const origin = {
      kind: "subagent" as const,
      subagentId: "sa_child",
      liveToolCallId: "child-tool-1",
      returnContent: {
        kind: "subagents" as const,
        parentMessageId: "parent-message",
        toolCallId: "delegate-tool",
        selectedSubagentId: "sa_child",
      },
    };
    mockSidebarContent = {
      command: "npm test",
      output: "passed",
      isExecuting: false,
      toolCallId: "child-tool-1",
      origin,
    };
    let childStatus = "running";
    mockUseQuery.mockImplementation((query) =>
      query === "getOwned"
        ? { status: childStatus, trigger_run_id: "run-child" }
        : [],
    );
    const delegatePart = {
      type: "tool-delegate_task",
      toolCallId: "delegate-tool",
      state: "output-available",
      input: { task: "test the change" },
      output: { agent_id: "sa_child" },
    };
    const parentMessage = {
      id: "parent-message",
      role: "assistant",
      parts: [delegatePart],
    };
    const { rerender } = render(
      <ComputerSidebar messages={[parentMessage]} status="streaming" />,
    );

    childStatus = "completed";
    rerender(<ComputerSidebar messages={[parentMessage]} status="streaming" />);
    expect(mockOpenSidebar).not.toHaveBeenCalled();

    rerender(
      <ComputerSidebar
        messages={[
          {
            ...parentMessage,
            parts: [
              delegatePart,
              {
                type: "tool-run_terminal_cmd",
                toolCallId: "parent-tool-2",
                state: "input-available",
                input: { command: "git status" },
              },
            ],
          },
        ]}
        status="streaming"
      />,
    );

    expect(mockOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "parent-tool-2",
        command: "git status",
      }),
    );
    expect(mockOpenSidebar.mock.calls.at(-1)?.[0]).not.toHaveProperty("origin");
  });

  it("keeps a historical subagent command pinned after completion", () => {
    const origin = {
      kind: "subagent" as const,
      subagentId: "sa_child",
      returnContent: {
        kind: "subagents" as const,
        parentMessageId: "parent-message",
        toolCallId: "delegate-tool",
      },
    };
    mockSidebarContent = {
      command: "npm test",
      output: "passed",
      isExecuting: false,
      toolCallId: "child-tool-1",
      origin,
    };
    let childStatus = "running";
    mockUseQuery.mockImplementation((query) =>
      query === "getOwned"
        ? { status: childStatus, trigger_run_id: "run-child" }
        : [],
    );
    const parentMessage = {
      id: "parent-message",
      role: "assistant",
      parts: [
        {
          type: "tool-delegate_task",
          toolCallId: "delegate-tool",
          state: "output-available",
          input: { task: "test the change" },
        },
      ],
    };
    const { rerender } = render(
      <ComputerSidebar messages={[parentMessage]} status="streaming" />,
    );

    childStatus = "completed";
    rerender(
      <ComputerSidebar
        messages={[
          {
            ...parentMessage,
            parts: [
              ...parentMessage.parts,
              {
                type: "tool-run_terminal_cmd",
                toolCallId: "parent-tool-2",
                state: "input-available",
                input: { command: "git status" },
              },
            ],
          },
        ]}
        status="streaming"
      />,
    );

    expect(mockOpenSidebar).not.toHaveBeenCalled();
  });

  it("still follows newly arriving tools in normal messages", () => {
    const onNavigate = jest.fn();
    const first = otherToolMessage.parts[0];
    const props = {
      sidebarOpen: true,
      sidebarContent: {
        command: "pwd",
        output: "/tmp\n",
        isExecuting: false,
        toolCallId: first.toolCallId,
      },
      closeSidebar: jest.fn(),
      onNavigate,
      status: "streaming" as const,
    };
    const { rerender } = render(
      <ComputerSidebarBase {...props} messages={[otherToolMessage]} />,
    );
    rerender(
      <ComputerSidebarBase
        {...props}
        messages={[
          {
            ...otherToolMessage,
            parts: [
              first,
              { ...first, toolCallId: "new-tool", input: { command: "date" } },
            ],
          },
        ]}
      />,
    );
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "new-tool" }),
    );
  });
});
