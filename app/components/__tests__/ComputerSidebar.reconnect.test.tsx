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
import { createToolInputErrorContent } from "@/lib/chat/tool-error-display";

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

const { ComputerSidebarBase } =
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

  it("shows safe tool failure details and provides a clear close action", () => {
    const closeSidebar = jest.fn();
    const rawError =
      'Invalid input for tool create_vulnerability_report: Value: {"evidence":"private"}';
    const toolError = createToolInputErrorContent({
      toolType: "tool-create_vulnerability_report",
      toolCallId: "finding-error",
    });

    render(
      <ComputerSidebarBase
        sidebarOpen
        sidebarContent={toolError}
        closeSidebar={closeSidebar}
        messages={[
          {
            role: "assistant",
            parts: [
              {
                type: "tool-create_vulnerability_report",
                toolCallId: "finding-error",
                state: "output-error",
                errorText: rawError,
              },
            ],
          },
        ]}
        status="ready"
      />,
    );

    expect(
      screen.getByText("The vulnerability report wasn’t saved"),
    ).toBeVisible();
    expect(screen.getByText("What to do next")).toBeVisible();
    expect(screen.queryByText(rawError)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(closeSidebar).toHaveBeenCalledTimes(1);
  });
});
