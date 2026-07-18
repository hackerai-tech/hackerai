import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { jest } from "@jest/globals";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SubmitStopButton } from "../SubmitStopButton";

const defaultProps = {
  isGenerating: false,
  hideStop: false,
  onStop: jest.fn(),
  onSubmit: jest.fn(),
  status: "ready" as const,
  isUploadingFiles: false,
  input: "test",
  uploadedFiles: [],
};

function renderButton(
  chatMode: "ask" | "agent",
  isPaid: boolean,
  isGenerating = false,
) {
  render(
    <TooltipProvider>
      <SubmitStopButton
        {...defaultProps}
        chatMode={chatMode}
        isPaid={isPaid}
        isGenerating={isGenerating}
        status={isGenerating ? "streaming" : "ready"}
      />
    </TooltipProvider>,
  );

  return screen.getByRole("button");
}

describe("SubmitStopButton paid mode colors", () => {
  it("uses the default submit treatment for paid Agent mode", () => {
    const button = renderButton("agent", true);

    expect(button).toHaveClass("bg-primary-foreground");
    expect(button).not.toHaveClass("bg-red-500/10");
  });

  it("uses the blue submit treatment for paid Ask mode", () => {
    expect(renderButton("ask", true)).toHaveClass("bg-blue-500/10");
  });

  it("uses neutral Agent and blue Ask stop treatments for paid users", () => {
    const { rerender } = render(
      <TooltipProvider>
        <SubmitStopButton
          {...defaultProps}
          chatMode="agent"
          isPaid
          isGenerating
          status="streaming"
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("button")).toHaveClass("bg-muted");

    rerender(
      <TooltipProvider>
        <SubmitStopButton
          {...defaultProps}
          chatMode="ask"
          isPaid
          isGenerating
          status="streaming"
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("button")).toHaveClass("bg-blue-500/10");
  });

  it("preserves the existing submit colors for free users", () => {
    expect(renderButton("agent", false)).toHaveClass("bg-red-500/10");
  });
});
