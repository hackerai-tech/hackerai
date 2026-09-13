import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, jest } from "@jest/globals";

jest.mock("../../SharedChatContext", () => ({
  useSharedChatContext: () => ({ openSidebar: jest.fn() }),
}));

const { SharedMessagePartHandler } =
  require("../SharedMessagePartHandler") as typeof import("../SharedMessagePartHandler");

describe("SharedMessagePartHandler subagents", () => {
  it.each([
    ["tool-create_agent", "Validator failed to start"],
    ["tool-send_message_to_agent", "Validator update failed"],
  ])("renders errorText as a failed %s call", (type, expectedAction) => {
    render(
      <SharedMessagePartHandler
        part={{
          type,
          input: { name: "Validator" },
          errorText: "Provider request failed",
        }}
        partIndex={0}
        isUser={false}
      />,
    );

    expect(screen.getByText(expectedAction)).toBeVisible();
  });

  it("preserves a failed cancellation target handle", () => {
    render(
      <SharedMessagePartHandler
        part={{
          type: "tool-cancel_agent",
          input: { target_agent_id: "sa_mapper" },
          output: {
            success: false,
            target_agent_id: "sa_mapper",
            error: "The target subagent was not found.",
          },
        }}
        partIndex={0}
        isUser={false}
      />,
    );

    expect(screen.getByText("sa_mapper cancel failed")).toBeVisible();
  });

  it("distinguishes unknown targeted waits from an empty agent set", () => {
    render(
      <SharedMessagePartHandler
        part={{
          type: "tool-wait_for_agents",
          output: {
            success: false,
            wait_outcome: "targets_not_found",
            target_agent_ids: ["sa_unknown"],
          },
        }}
        partIndex={0}
        isUser={false}
      />,
    );

    expect(screen.getByText("Subagent targets not found")).toBeVisible();
  });

  it("shows durable and active subagent counts", () => {
    render(
      <SharedMessagePartHandler
        part={{
          type: "tool-list_agents",
          output: {
            success: true,
            agents: [
              { agent_id: "sa_done", status: "completed" },
              { agent_id: "sa_active", status: "finalizing" },
            ],
          },
        }}
        partIndex={0}
        isUser={false}
      />,
    );

    expect(screen.getByText("2 total · 1 active")).toBeVisible();
  });
});
