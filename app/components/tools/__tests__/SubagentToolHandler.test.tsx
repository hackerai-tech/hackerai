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

  it("does not open the sidebar when delegation failed before creating a child", () => {
    render(
      <SubagentToolHandler
        message={
          {
            id: "parent-run",
            role: "assistant",
            parts: [],
          } as any
        }
        status="ready"
        part={{
          type: "tool-delegate_task",
          toolCallId: "tool-delegate-1",
          state: "output-error",
          input: {
            profile_input: { candidate: { title: "Stored XSS" } },
          },
          errorText:
            "Could not find public function for 'subagents:reserveForBackend'",
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Subagent failed Stored XSS/i }),
    );
    expect(openSidebar).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Open Stored XSS in sidebar" }),
    ).not.toBeInTheDocument();
  });

  it("opens completed delegation without model-visible runtime identifiers", () => {
    render(
      <SubagentToolHandler
        message={
          {
            id: "parent-run",
            role: "assistant",
            parts: [],
          } as any
        }
        status="ready"
        part={{
          type: "tool-delegate_task",
          toolCallId: "tool-delegate-1",
          state: "output-available",
          input: {
            profile_input: { candidate: { title: "Stored XSS" } },
          },
          output: { status: "completed", verdict: "confirmed" },
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

  it("does not open a failed delegation that never created a child", () => {
    render(
      <SubagentToolHandler
        message={
          {
            id: "parent-run",
            role: "assistant",
            parts: [],
          } as any
        }
        status="ready"
        part={{
          type: "tool-delegate_task",
          toolCallId: "tool-delegate-1",
          state: "output-available",
          input: {
            profile_input: { candidate: { title: "Stored XSS" } },
          },
          output: { status: "failed" },
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Open Stored XSS in sidebar" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a failed child inspectable through UI-only lifecycle linkage", () => {
    render(
      <SubagentToolHandler
        message={
          {
            id: "parent-run",
            role: "assistant",
            parts: [
              {
                type: "data-subagent-lifecycle",
                data: {
                  subagent_id: "sa_internal",
                  parent_tool_call_id: "tool-delegate-1",
                },
              },
            ],
          } as any
        }
        status="ready"
        part={{
          type: "tool-delegate_task",
          toolCallId: "tool-delegate-1",
          state: "output-available",
          input: {
            profile_input: { candidate: { title: "Stored XSS" } },
          },
          output: { status: "failed" },
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
