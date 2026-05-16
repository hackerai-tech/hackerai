import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { isSidebarTerminal, type SidebarContent } from "@/types/chat";

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

function ToolSidebarHarness() {
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
});
