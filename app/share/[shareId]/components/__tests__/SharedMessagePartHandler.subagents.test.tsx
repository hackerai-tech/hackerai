import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, jest } from "@jest/globals";

jest.mock("../../SharedChatContext", () => ({
  useSharedChatContext: () => ({ openSidebar: jest.fn() }),
}));

const { SharedMessagePartHandler } =
  require("../SharedMessagePartHandler") as typeof import("../SharedMessagePartHandler");

describe("SharedMessagePartHandler subagent failures", () => {
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
});
