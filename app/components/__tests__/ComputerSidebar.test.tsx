import "@testing-library/jest-dom";
import React from "react";
import { act, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { SidebarContent } from "@/types/chat";

type MockState = {
  sidebarOpen: boolean;
  sidebarContent: SidebarContent | null;
  sidebarOpenRequest: number;
};
let mockState: MockState;
const mockUseQuery = jest.fn<any>();
// Mirrors GlobalState: only explicit opens advance the request counter.
const mockOpenSidebar = jest.fn((content: SidebarContent) => {
  mockState = {
    sidebarOpen: true,
    sidebarContent: content,
    sidebarOpenRequest: mockState.sidebarOpenRequest + 1,
  };
});
const mockSetSidebarContent = jest.fn((content: SidebarContent | null) => {
  mockState = { ...mockState, sidebarContent: content };
});
const mockCloseSidebar = jest.fn(() => {
  mockState = { ...mockState, sidebarOpen: false, sidebarContent: null };
});
const mockWorkspace = {
  mounts: 0,
  unmounts: 0,
  props: null as null | {
    open: boolean;
    openRequest: number;
    selection: SidebarContent | null;
  },
};

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: (loader: () => unknown) => {
    const { useEffect } = jest.requireActual<typeof import("react")>("react");
    if (!String(loader).includes("ComputerWorkspace")) {
      return function MockDynamicComponent() {
        return <div data-testid="dynamic-component" />;
      };
    }
    return function MockComputerWorkspace(props: typeof mockWorkspace.props) {
      mockWorkspace.props = props;
      useEffect(() => {
        mockWorkspace.mounts += 1;
        return () => {
          mockWorkspace.unmounts += 1;
        };
      }, []);
      return <div data-testid="computer-workspace" hidden={!props?.open} />;
    };
  },
}));
jest.mock("next/image", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("convex/react", () => ({
  useAction: () => jest.fn(),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));
jest.mock("@/convex/_generated/api", () => ({
  api: {
    agentGoals: { get: "getGoal" },
    browserHandoffs: { getForUser: "getForUser" },
    subagents: {
      getOwned: "getOwned",
      getMessagesOwned: "getMessagesOwned",
    },
  },
}));
jest.mock("@/app/hooks/useSubagentRealtime", () => ({
  useSubagentRealtime: () => ({
    message: null,
    state: "idle",
    retry: jest.fn(),
  }),
}));
jest.mock("@/hooks/use-workspace-layout", () => ({
  useComputerSidebarOverlay: () => false,
}));
jest.mock("../ComputerPanelToggle", () => ({
  useWorkspaceFilesEnabled: () => true,
}));
jest.mock("../AgentGoalEditor", () => ({
  AgentGoalEditor: () => <div data-testid="goal-editor" />,
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    ...mockState,
    openSidebar: mockOpenSidebar,
    setSidebarContent: mockSetSidebarContent,
    closeSidebar: mockCloseSidebar,
    consumeBrowserTakeoverRequest: jest.fn(),
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
jest.mock("../TerminalCodeBlock", () => ({
  TerminalCodeBlock: ({ command }: { command: string }) => <pre>{command}</pre>,
}));
jest.mock("../TodoPanel", () => ({ TodoPanel: () => null }));

const { ComputerSidebar } =
  require("../ComputerSidebar") as typeof import("../ComputerSidebar");

const parentTool: SidebarContent = {
  command: "ls",
  output: "report.txt",
  isExecuting: false,
  toolCallId: "parent-tool-1",
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockUseQuery.mockReset();
  mockUseQuery.mockReturnValue(undefined);
  mockWorkspace.mounts = 0;
  mockWorkspace.unmounts = 0;
  mockWorkspace.props = null;
  mockState = {
    sidebarOpen: true,
    sidebarContent: parentTool,
    sidebarOpenRequest: 1,
  };
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe("ComputerSidebar with Computer tabs", () => {
  it("hides Computer behind the Goal editor without unmounting its tabs", () => {
    mockUseQuery.mockImplementation((query) =>
      query === "getGoal"
        ? {
            _id: "goal",
            objective: "Keep working",
            criteria: [],
            state: "running",
          }
        : undefined,
    );
    const { rerender } = render(
      <ComputerSidebar chatId="chat" messages={[]} />,
    );
    expect(mockWorkspace.props?.open).toBe(true);

    act(() => mockOpenSidebar({ kind: "goal", chatId: "chat" }));
    rerender(<ComputerSidebar chatId="chat" messages={[]} />);
    expect(screen.getByTestId("goal-editor")).toBeInTheDocument();
    expect(mockWorkspace.props?.open).toBe(false);
    expect(mockWorkspace.props?.selection).toBeNull();

    act(() => mockCloseSidebar());
    rerender(<ComputerSidebar chatId="chat" messages={[]} />);
    act(() => mockOpenSidebar(parentTool));
    rerender(<ComputerSidebar chatId="chat" messages={[]} />);
    expect(screen.queryByTestId("goal-editor")).not.toBeInTheDocument();
    expect(mockWorkspace.props?.open).toBe(true);
    // The same instance kept its open tabs and retained snapshot bytes.
    expect(mockWorkspace.mounts).toBe(1);
    expect(mockWorkspace.unmounts).toBe(0);
  });

  it("returns from a finished subagent without replaying opens as a Computer open request", () => {
    let childStatus = "running";
    mockUseQuery.mockImplementation((query) =>
      query === "getOwned"
        ? { status: childStatus, trigger_run_id: "run-child" }
        : query === "getMessagesOwned"
          ? []
          : undefined,
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
    const view = (messages: unknown[]) => (
      <ComputerSidebar chatId="chat" messages={messages} status="streaming" />
    );
    const { rerender } = render(view([parentMessage]));
    const requestBeforeSubagent = mockWorkspace.props?.openRequest;

    // The user follows the live subagent command (an explicit, nested open).
    act(() =>
      mockOpenSidebar({
        command: "npm test",
        output: "passed",
        isExecuting: false,
        toolCallId: "child-tool-1",
        origin: {
          kind: "subagent",
          subagentId: "sa_child",
          liveToolCallId: "child-tool-1",
          returnContent: {
            kind: "subagents",
            parentMessageId: "parent-message",
            toolCallId: "delegate-tool",
            selectedSubagentId: "sa_child",
          },
        },
      }),
    );
    rerender(view([parentMessage]));
    expect(mockWorkspace.props?.open).toBe(false);

    childStatus = "completed";
    rerender(view([parentMessage]));
    const withNextParentTool = [
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
    ];
    rerender(view(withNextParentTool));
    expect(mockSetSidebarContent).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "parent-tool-2" }),
    );
    expect(mockOpenSidebar).toHaveBeenCalledTimes(1);
    rerender(view(withNextParentTool));

    // Computer shows the new parent tool but keeps the user's selected tab.
    expect(mockWorkspace.props).toMatchObject({
      open: true,
      selection: expect.objectContaining({ toolCallId: "parent-tool-2" }),
      openRequest: requestBeforeSubagent,
    });

    // An explicit open still reaches Computer.
    act(() => mockOpenSidebar(parentTool));
    rerender(view(withNextParentTool));
    expect(mockWorkspace.props?.openRequest).not.toBe(requestBeforeSubagent);
    expect(mockWorkspace.unmounts).toBe(0);
  });

  it("shows a subagent's captured edit with the workspace-files preview", () => {
    mockUseQuery.mockImplementation((query) =>
      query === "getOwned"
        ? { status: "completed", trigger_run_id: "run-child" }
        : query === "getMessagesOwned"
          ? [
              {
                role: "assistant",
                sequence: 1,
                parts: [
                  {
                    type: "tool-file",
                    toolCallId: "child-edit",
                    state: "output-available",
                    input: { action: "edit", path: "/work/app.ts" },
                    output: {
                      originalContent: "old\n",
                      modifiedContent: "new\n",
                    },
                  },
                ],
              },
            ]
          : undefined,
    );
    mockState = {
      ...mockState,
      sidebarContent: {
        path: "/work/app.ts",
        content: "new\n",
        action: "editing",
        toolCallId: "child-edit",
        originalContent: "old\n",
        modifiedContent: "new\n",
        origin: {
          kind: "subagent",
          subagentId: "sa_child",
          returnContent: {
            kind: "subagents",
            parentMessageId: "parent-message",
            toolCallId: "delegate-tool",
          },
        },
      },
    };
    render(<ComputerSidebar chatId="chat" messages={[]} status="ready" />);
    expect(screen.getByTestId("dynamic-component")).toBeInTheDocument();
    // The capture preview owns its actions, so the diff toolbar is hidden.
    expect(screen.queryByTestId("code-action-buttons")).not.toBeInTheDocument();
  });
});
