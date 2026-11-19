import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { WaitForUserToolHandler } from "../WaitForUserToolHandler";

describe("wait_for_user tool row", () => {
  it("shows a static waiting state and the delivered reply", () => {
    const { rerender } = render(
      <WaitForUserToolHandler
        status="streaming"
        part={{ state: "input-available", toolCallId: "tool-1" }}
      />,
    );
    expect(screen.getByText("Waiting for your reply")).toBeInTheDocument();

    rerender(
      <WaitForUserToolHandler
        status="streaming"
        part={{
          state: "output-available",
          toolCallId: "tool-1",
          output: { success: true, reply: "Option A\nThen B" },
        }}
      />,
    );
    expect(screen.getByText("Reply received")).toBeInTheDocument();
    expect(screen.getByTestId("wait-for-user-tool-1")).toHaveTextContent(
      "Option A Then B",
    );
  });

  it("does not show a stale waiting label after cancellation", () => {
    render(
      <WaitForUserToolHandler
        status="ready"
        part={{ state: "input-available", toolCallId: "stopped-wait" }}
      />,
    );

    expect(screen.getByText("Wait ended without a reply")).toBeInTheDocument();
  });
});
