import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import {
  isSidebarTerminal,
  type SidebarContent,
  type SidebarSubagentOrigin,
} from "@/types/chat";
import { ToolSidebarOriginProvider } from "@/app/contexts/ToolSidebarOriginContext";

let mockSidebarOpen = false;
let mockSidebarContent: SidebarContent | null = null;
const mockOpenSidebar = jest.fn((content: SidebarContent) => {
  mockSidebarContent = content;
  mockSidebarOpen = true;
});
const mockCloseSidebar = jest.fn(() => {
  mockSidebarContent = null;
  mockSidebarOpen = false;
});
const mockUpdateSidebarContent = jest.fn();

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    openSidebar: mockOpenSidebar,
    closeSidebar: mockCloseSidebar,
    sidebarOpen: mockSidebarOpen,
    sidebarContent: mockSidebarContent,
    updateSidebarContent: mockUpdateSidebarContent,
  }),
}));

const { useToolSidebar } =
  jest.requireActual<typeof import("../useToolSidebar")>("../useToolSidebar");

const terminalContent = {
  command: "ls",
  output: "",
  isExecuting: false,
  toolCallId: "tool-1",
};

function ToolSidebarButton() {
  const { handleOpenInSidebar, handleKeyDown, isSidebarActive } =
    useToolSidebar({
      toolCallId: "tool-1",
      content: terminalContent,
      typeGuard: isSidebarTerminal,
    });

  return (
    <button
      type="button"
      data-active={isSidebarActive}
      onClick={handleOpenInSidebar}
      onKeyDown={handleKeyDown}
    >
      Open terminal
    </button>
  );
}

function ToolSidebarHarness({ origin }: { origin?: SidebarSubagentOrigin }) {
  return origin ? (
    <ToolSidebarOriginProvider origin={origin}>
      <ToolSidebarButton />
    </ToolSidebarOriginProvider>
  ) : (
    <ToolSidebarButton />
  );
}

describe("useToolSidebar", () => {
  beforeEach(() => {
    mockSidebarOpen = false;
    mockSidebarContent = null;
  });

  it("closes the active computer sidebar with Escape from the tool trigger", () => {
    const { rerender } = render(<ToolSidebarHarness />);
    const button = screen.getByRole("button", { name: "Open terminal" });

    fireEvent.click(button);
    rerender(<ToolSidebarHarness />);

    expect(button).toHaveAttribute("data-active", "true");

    fireEvent.keyDown(button, { key: "Escape" });

    expect(mockCloseSidebar).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape when the trigger is not the active sidebar content", () => {
    render(<ToolSidebarHarness />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Open terminal" }), {
      key: "Escape",
    });

    expect(mockCloseSidebar).not.toHaveBeenCalled();
  });

  it("preserves the subagent return destination when opening a child tool", () => {
    const origin: SidebarSubagentOrigin = {
      kind: "subagent",
      subagentId: "sa_child",
      returnContent: {
        kind: "subagents",
        parentMessageId: "parent-message",
        toolCallId: "delegate-tool",
        selectedSubagentId: "sa_child",
      },
    };

    render(<ToolSidebarHarness origin={origin} />);
    fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));

    expect(mockOpenSidebar).toHaveBeenCalledWith({
      ...terminalContent,
      origin,
    });
  });
});
