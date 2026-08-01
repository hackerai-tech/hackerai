import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const openSidebar = jest.fn();
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    openSidebar,
    closeSidebar: jest.fn(),
    sidebarOpen: false,
    sidebarContent: null,
    updateSidebarContent: jest.fn(),
  }),
}));

const { SubagentToolHandler } =
  require("../SubagentToolHandler") as typeof import("../SubagentToolHandler");

describe("SubagentToolHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("opens the parent run's Subagents sidebar from the waiting tool block", () => {
    render(
      <SubagentToolHandler
        message={
          {
            id: "parent-run",
            role: "assistant",
            parts: [],
          } as any
        }
        status="streaming"
        part={{
          type: "tool-delegate_task",
          toolCallId: "tool-delegate-1",
          state: "input-available",
          input: {
            profile_input: { candidate: { title: "Stored XSS" } },
          },
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Stored XSS in sidebar" }),
    );
    expect(openSidebar).toHaveBeenCalledWith({
      kind: "subagents",
      parentMessageId: "parent-run",
      toolCallId: "tool-delegate-1",
    });
  });
});
