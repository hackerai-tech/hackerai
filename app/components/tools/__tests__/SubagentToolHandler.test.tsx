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

const { SubagentToolGroup, SubagentToolHandler } =
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

    fireEvent.click(screen.getByRole("button", { name: /Stored XSS failed/i }));
    expect(openSidebar).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Open Stored XSS in sidebar" }),
    ).not.toBeInTheDocument();
  });

  it("names the exact agent when it starts", () => {
    render(
      <SubagentToolHandler
        message={{ id: "parent-run", role: "assistant", parts: [] } as any}
        status="ready"
        part={{
          type: "tool-create_agent",
          toolCallId: "tool-create-1",
          state: "output-available",
          input: { name: "Stored XSS validator", task: "Validate XSS" },
          output: {
            success: true,
            agent_id: "sa_xss",
            name: "Stored XSS validator",
            status: "queued",
          },
        }}
      />,
    );

    expect(
      screen.getByRole("group", {
        name: "Stored XSS validator started working",
      }),
    ).toBeInTheDocument();
  });

  it("names and opens the exact agent when it is updated", () => {
    render(
      <SubagentToolHandler
        message={
          {
            id: "update-message",
            role: "assistant",
            parts: [
              {
                type: "data-subagent-lifecycle",
                data: {
                  subagent_id: "sa_xss",
                  parent_message_id: "create-message",
                  parent_tool_call_id: "tool-send-1",
                  agent_name: "Stored XSS validator",
                  status: "running",
                },
              },
            ],
          } as any
        }
        status="ready"
        part={{
          type: "tool-send_message_to_agent",
          toolCallId: "tool-send-1",
          state: "output-available",
          input: { target_agent_id: "sa_xss", message: "Use new evidence" },
          output: {
            success: true,
            target_agent_id: "sa_xss",
            target_agent_name: "Stored XSS validator",
          },
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Stored XSS validator in sidebar",
      }),
    );
    expect(
      screen.getByRole("group", { name: "Stored XSS validator updated" }),
    ).toBeInTheDocument();
    expect(openSidebar).toHaveBeenCalledWith({
      kind: "subagents",
      parentMessageId: "create-message",
      toolCallId: "tool-send-1",
      selectedSubagentId: "sa_xss",
    });
  });

  it("names the exact agent when waiting receives its completion", () => {
    render(
      <SubagentToolHandler
        message={
          {
            id: "wait-message",
            role: "assistant",
            parts: [
              {
                type: "data-subagent-lifecycle",
                data: {
                  subagent_id: "sa_xss",
                  parent_message_id: "create-message",
                  parent_tool_call_id: "tool-wait-1",
                  agent_name: "Stored XSS validator",
                  status: "completed",
                },
              },
            ],
          } as any
        }
        status="ready"
        part={{
          type: "tool-wait_for_agents",
          toolCallId: "tool-wait-1",
          state: "output-available",
          input: { reason: "Waiting for XSS validation" },
          output: {
            success: true,
            wait_outcome: "agent_finished",
            agent_id: "sa_xss",
            agent_name: "Stored XSS validator",
            result: { status: "completed", verdict: "confirmed" },
          },
        }}
      />,
    );

    expect(
      screen.getByRole("group", { name: "Stored XSS validator finished" }),
    ).toBeInTheDocument();
  });

  it("shows adjacent child starts as one row with distinct visual identities", () => {
    const parts = [
      {
        type: "tool-create_agent",
        toolCallId: "tool-create-vercel",
        state: "output-available",
        input: { name: "Collect vercel", task: "Collect Vercel evidence" },
        output: {
          success: true,
          agent_id: "sa_vercel",
          name: "Collect vercel",
          status: "queued",
        },
      },
      {
        type: "tool-create_agent",
        toolCallId: "tool-create-posthog",
        state: "output-available",
        input: { name: "Collect posthog", task: "Collect PostHog evidence" },
        output: {
          success: true,
          agent_id: "sa_posthog",
          name: "Collect posthog",
          status: "queued",
        },
      },
      {
        type: "tool-create_agent",
        toolCallId: "tool-create-trigger",
        state: "output-available",
        input: { name: "Collect trigger", task: "Collect Trigger evidence" },
        output: {
          success: true,
          agent_id: "sa_trigger",
          name: "Collect trigger",
          status: "queued",
        },
      },
    ];

    render(
      <SubagentToolGroup
        message={{ id: "parent-run", role: "assistant", parts } as any}
        parts={parts}
        status="ready"
      />,
    );

    expect(screen.getAllByText("started working")).toHaveLength(1);
    const buttons = [
      screen.getByRole("button", {
        name: "Open Collect vercel in sidebar",
      }),
      screen.getByRole("button", {
        name: "Open Collect posthog in sidebar",
      }),
      screen.getByRole("button", {
        name: "Open Collect trigger in sidebar",
      }),
    ];
    expect(
      new Set(buttons.map((button) => button.dataset.subagentVisual)).size,
    ).toBe(3);

    fireEvent.click(buttons[1]);
    expect(openSidebar).toHaveBeenCalledWith({
      kind: "subagents",
      parentMessageId: "parent-run",
      toolCallId: "tool-create-posthog",
      selectedSubagentId: "sa_posthog",
    });
  });

  it("renders more children than the unique visual palette without hanging", () => {
    const parts = Array.from({ length: 7 }, (_, index) => ({
      type: "tool-create_agent",
      toolCallId: `tool-create-${index}`,
      state: "output-available",
      input: { name: `Validator ${index + 1}`, task: "Validate candidate" },
      output: {
        success: true,
        agent_id: `sa_${index}`,
        name: `Validator ${index + 1}`,
        status: "queued",
      },
    }));

    render(
      <SubagentToolGroup
        message={{ id: "parent-run", role: "assistant", parts } as any}
        parts={parts}
        status="ready"
      />,
    );

    expect(
      screen.getAllByRole("button", { name: /Open Validator \d in sidebar/ }),
    ).toHaveLength(7);
    expect(screen.getAllByText("started working")).toHaveLength(1);
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
