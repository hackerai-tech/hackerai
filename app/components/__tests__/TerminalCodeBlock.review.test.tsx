import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => () => null,
}));

import { TerminalCodeBlock } from "../TerminalCodeBlock";

describe("TerminalCodeBlock automatic review preview", () => {
  it("renders CAPTCHA status without falling back to the runtime command", () => {
    render(
      <TerminalCodeBlock
        command="hackerai-captcha solve --session synthetic"
        captcha={{ state: "response_delivered", elapsedMs: 53000 }}
        status="ready"
        variant="sidebar"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Response delivered");
    expect(screen.getByLabelText("Elapsed time")).toHaveTextContent("0:53");
    expect(screen.queryByText(/hackerai-captcha/)).not.toBeInTheDocument();
    expect(screen.queryByText("Command details")).not.toBeInTheDocument();
  });
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
