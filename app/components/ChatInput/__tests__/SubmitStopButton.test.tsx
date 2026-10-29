import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jest } from "@jest/globals";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SubmitStopButton } from "../SubmitStopButton";

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: class ResizeObserverMock {
    observe() {
      return undefined;
    }

    unobserve() {
      return undefined;
    }

    disconnect() {
      return undefined;
    }
  },
});

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
  useNeutralAgentStyle = false,
) {
  render(
    <TooltipProvider>
      <SubmitStopButton
        {...defaultProps}
        chatMode={chatMode}
        isPaid={isPaid}
        useNeutralAgentStyle={useNeutralAgentStyle}
        isGenerating={isGenerating}
        status={isGenerating ? "streaming" : "ready"}
      />
    </TooltipProvider>,
  );

  return screen.getByRole("button");
}

describe("SubmitStopButton paid mode colors", () => {
  it.each([
    {
      sendDisabledReason: undefined,
      tooltip: "Send message and pause goal (⏎)",
    },
    { sendDisabledReason: "Messages loading", tooltip: "Messages loading" },
  ])(
    "explains a goal follow-up while preserving the blocking reason: $tooltip",
    async ({ sendDisabledReason, tooltip }) => {
      const user = userEvent.setup();
      render(
        <TooltipProvider delayDuration={0}>
          <SubmitStopButton
            {...defaultProps}
            chatMode="agent"
            pausesGoal
            sendDisabledReason={sendDisabledReason}
          />
        </TooltipProvider>,
      );
      const sendButton = screen.getByLabelText("Send message and pause goal");
      if (sendDisabledReason) expect(sendButton).toBeDisabled();
      else expect(sendButton).toBeEnabled();
      await user.hover(sendButton.parentElement!);
      expect(await screen.findByText(tooltip)).toBeInTheDocument();
    },
  );

  it("disables sending while offline without hiding the composer action", () => {
    render(
      <TooltipProvider>
        <SubmitStopButton {...defaultProps} chatMode="ask" isOnline={false} />
      </TooltipProvider>,
    );

    expect(screen.getByLabelText("Send message")).toBeDisabled();
  });

  it("prioritizes the loading reason while destination messages load", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <SubmitStopButton
          {...defaultProps}
          chatMode="ask"
          isOnline={false}
          sendDisabledReason="Messages loading"
        />
      </TooltipProvider>,
    );

    const sendButton = screen.getByLabelText("Send message");
    expect(sendButton).toBeDisabled();

    await user.hover(sendButton.parentElement!);

    expect(await screen.findByText("Messages loading")).toBeInTheDocument();
  });

  it.each([
    { isOnline: false },
    { isUploadingFiles: true },
    { sendDisabledReason: "Wait for the attachment to finish removing." },
    { status: "submitted" as const },
  ])(
    "keeps Stop available when a goal follow-up is blocked by %j",
    (blocked) => {
      render(
        <TooltipProvider>
          <SubmitStopButton
            {...defaultProps}
            chatMode="agent"
            isGenerating
            allowSendWhileGenerating
            status="streaming"
            {...blocked}
          />
        </TooltipProvider>,
      );
      expect(screen.getByLabelText("Send message")).toBeDisabled();
      expect(screen.getByLabelText("Stop generation")).toBeEnabled();
    },
  );

  it("uses the default submit treatment for paid Agent mode", () => {
    const button = renderButton("agent", true);

    expect(button).toHaveClass("bg-primary-foreground");
    expect(button).not.toHaveClass("bg-red-500/10");
  });

  it("uses the green submit treatment for paid Ask mode", () => {
    expect(renderButton("ask", true)).toHaveClass("bg-emerald-500/10");
  });

  it("uses neutral Agent and green Ask stop treatments for paid users", () => {
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

    expect(screen.getByRole("button")).toHaveClass("bg-emerald-500/10");
  });

  it("preserves the existing submit colors for free users", () => {
    expect(renderButton("agent", false)).toHaveClass("bg-red-500/10");
  });

  it("uses the neutral Agent submit treatment for free Desktop users", () => {
    const submitButton = renderButton("agent", false, false, true);

    expect(submitButton).toHaveClass("bg-primary-foreground");
    expect(submitButton).not.toHaveClass("bg-red-500/10");
  });

  it("uses the neutral Agent stop treatment for free Desktop users", () => {
    const stopButton = renderButton("agent", false, true, true);

    expect(stopButton).toHaveClass("bg-muted");
    expect(stopButton).not.toHaveClass("bg-red-500/10");
  });
});
