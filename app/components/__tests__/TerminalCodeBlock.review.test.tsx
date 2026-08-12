import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => () => null,
}));

import { TerminalCodeBlock } from "../TerminalCodeBlock";

describe("TerminalCodeBlock automatic review preview", () => {
  it("shows the exact command before execution starts", () => {
    render(
      <TerminalCodeBlock
        command="wafw00f https://hackerone.com"
        executionPhase="reviewing"
        isExecuting={false}
        status="ready"
        variant="sidebar"
      />,
    );

    expect(screen.getByText("$ wafw00f https://hackerone.com")).toBeVisible();
    expect(screen.getByText("Reviewing before execution…")).toBeVisible();
    expect(screen.queryByText("Executing command")).not.toBeInTheDocument();
  });
});
