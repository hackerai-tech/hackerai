import "@testing-library/jest-dom";
import { describe, it, expect, jest } from "@jest/globals";
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

import { FinishReasonNotice } from "../FinishReasonNotice";
import { DataStreamProvider, useDataStream } from "../DataStreamProvider";
import { MAX_AUTO_CONTINUES } from "@/app/hooks/useAutoContinue";
import { POST_SUMMARIZATION_INCOMPLETE_FINISH_REASON } from "@/lib/chat/stop-conditions";
import type { ChatMode, SelectedModel } from "@/types/chat";

function DataStreamSetter({
  isAutoResuming,
  autoContinueCount,
  children,
}: {
  isAutoResuming?: boolean;
  autoContinueCount?: number;
  children: React.ReactNode;
}) {
  const { setIsAutoResuming, setAutoContinueCount } = useDataStream();

  React.useEffect(() => {
    if (isAutoResuming !== undefined) setIsAutoResuming(isAutoResuming);
    if (autoContinueCount !== undefined)
      setAutoContinueCount(autoContinueCount);
  }, [
    isAutoResuming,
    autoContinueCount,
    setIsAutoResuming,
    setAutoContinueCount,
  ]);

  return <>{children}</>;
}

interface RenderNoticeProps {
  finishReason?: string;
  mode?: ChatMode;
  agentRunSpendCapPremiumContinuationAllowed?: boolean;
  onContinue?: (selectedModelOverride?: SelectedModel) => void;
}

function renderNotice(
  props: RenderNoticeProps,
  contextOverrides?: { isAutoResuming?: boolean; autoContinueCount?: number },
) {
  return render(
    <DataStreamProvider>
      <DataStreamSetter {...contextOverrides}>
        <FinishReasonNotice {...props} />
      </DataStreamSetter>
    </DataStreamProvider>,
  );
}

describe("FinishReasonNotice", () => {
  describe("suppression cases (should render nothing)", () => {
    it.each([
      { finishReason: "length", mode: "agent" as ChatMode },
      { finishReason: "context-limit", mode: "agent" as ChatMode },
      { finishReason: "tool-calls", mode: "agent" as ChatMode },
      { finishReason: "timeout", mode: "ask" as ChatMode },
    ])(
      "returns null when isAutoResuming is true (finishReason=$finishReason, mode=$mode)",
      ({ finishReason, mode }) => {
        const { container } = renderNotice(
          { finishReason, mode },
          { isAutoResuming: true, autoContinueCount: 0 },
        );
        expect(container.innerHTML).toBe("");
      },
    );

    it.each([
      { finishReason: "context-limit" as const, autoContinueCount: 0 },
      { finishReason: "context-limit" as const, autoContinueCount: 2 },
      { finishReason: "context-limit" as const, autoContinueCount: 4 },
      { finishReason: "length" as const, autoContinueCount: 0 },
      { finishReason: "length" as const, autoContinueCount: 3 },
      { finishReason: "length" as const, autoContinueCount: 4 },
      { finishReason: "tool-calls" as const, autoContinueCount: 0 },
      { finishReason: "tool-calls" as const, autoContinueCount: 2 },
      { finishReason: "tool-calls" as const, autoContinueCount: 4 },
      { finishReason: "preemptive-timeout" as const, autoContinueCount: 0 },
      {
        finishReason: POST_SUMMARIZATION_INCOMPLETE_FINISH_REASON,
        autoContinueCount: 0,
      },
      {
        finishReason: POST_SUMMARIZATION_INCOMPLETE_FINISH_REASON,
        autoContinueCount: 4,
      },
    ])(
      "returns null in agent mode when autoContinueCount=$autoContinueCount < MAX for finishReason=$finishReason",
      ({ finishReason, autoContinueCount }) => {
        const { container } = renderNotice(
          { finishReason, mode: "agent" },
          { isAutoResuming: false, autoContinueCount },
        );
        expect(container.innerHTML).toBe("");
      },
    );

    it("returns null when finishReason is undefined", () => {
      const { container } = renderNotice(
        { finishReason: undefined, mode: "agent" },
        { isAutoResuming: false, autoContinueCount: MAX_AUTO_CONTINUES },
      );
      expect(container.innerHTML).toBe("");
    });

    it("returns null for an unknown finishReason", () => {
      const { container } = renderNotice(
        { finishReason: "unknown-reason", mode: "agent" },
        { isAutoResuming: false, autoContinueCount: MAX_AUTO_CONTINUES },
      );
      expect(container.innerHTML).toBe("");
    });
  });

  describe("rendering cases (should show notice)", () => {
    it.each([
      {
        finishReason: "tool-calls",
        expectedText: "Reached the step limit for this turn",
      },
      {
        finishReason: "timeout",
        expectedText: "Reached the time limit for this turn",
      },
      {
        finishReason: "length",
        expectedText: "Reached the output limit for this turn",
      },
      {
        finishReason: "context-limit",
        expectedText: "Reached the context limit for this conversation",
      },
      {
        finishReason: "budget-exhausted",
        expectedText: "Stopped at a usage guardrail for this run",
      },
      {
        finishReason: POST_SUMMARIZATION_INCOMPLETE_FINISH_REASON,
        expectedText: "Paused after compacting the conversation",
      },
    ])(
      "renders notice for finishReason=$finishReason when autoContinueCount has reached MAX_AUTO_CONTINUES",
      ({ finishReason, expectedText }) => {
        renderNotice(
          { finishReason, mode: "agent" },
          { isAutoResuming: false, autoContinueCount: MAX_AUTO_CONTINUES },
        );
        expect(screen.getByText(new RegExp(expectedText))).toBeInTheDocument();
      },
    );

    it.each([
      {
        finishReason: "context-limit",
        mode: "ask" as ChatMode,
        expectedText: "Reached the context limit for this conversation",
      },
      {
        finishReason: "length",
        mode: "ask" as ChatMode,
        expectedText: "Reached the output limit for this turn",
      },
    ])(
      "renders notice for finishReason=$finishReason in $mode mode with autoContinueCount=0 (auto-continue only applies to agent mode)",
      ({ finishReason, mode, expectedText }) => {
        const { container } = renderNotice(
          { finishReason, mode },
          { isAutoResuming: false, autoContinueCount: 0 },
        );
        expect(container.innerHTML).not.toBe("");
        expect(screen.getByText(new RegExp(expectedText))).toBeInTheDocument();
      },
    );

    it("renders timeout notice in agent mode even with autoContinueCount=0 (timeout is not auto-continuable)", () => {
      renderNotice(
        { finishReason: "timeout", mode: "agent" },
        { isAutoResuming: false, autoContinueCount: 0 },
      );
      expect(
        screen.getByText(/Reached the time limit for this turn/),
      ).toBeInTheDocument();
    });
  });

  describe("Continue button", () => {
    it("does not render the Continue button when onContinue is not provided", () => {
      renderNotice(
        { finishReason: "tool-calls", mode: "agent" },
        { isAutoResuming: false, autoContinueCount: MAX_AUTO_CONTINUES },
      );
      expect(
        screen.queryByRole("button", { name: /continue/i }),
      ).not.toBeInTheDocument();
    });

    it("renders the Continue button when onContinue is provided", () => {
      const onContinue = jest.fn();
      renderNotice(
        { finishReason: "tool-calls", mode: "agent", onContinue },
        { isAutoResuming: false, autoContinueCount: MAX_AUTO_CONTINUES },
      );
      expect(
        screen.getByRole("button", { name: /continue/i }),
      ).toBeInTheDocument();
    });

    it("invokes onContinue when the button is clicked", () => {
      const onContinue = jest.fn();
      renderNotice(
        { finishReason: "tool-calls", mode: "agent", onContinue },
        { isAutoResuming: false, autoContinueCount: MAX_AUTO_CONTINUES },
      );
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
      expect(onContinue).toHaveBeenCalledTimes(1);
    });

    it.each([
      "tool-calls",
      "timeout",
      "length",
      "context-limit",
      "preemptive-timeout",
      "agent-run-spend-cap",
      POST_SUMMARIZATION_INCOMPLETE_FINISH_REASON,
    ])("renders the Continue button for finishReason=%s", (finishReason) => {
      const onContinue = jest.fn();
      renderNotice(
        { finishReason, mode: "agent", onContinue },
        { isAutoResuming: false, autoContinueCount: MAX_AUTO_CONTINUES },
      );
      expect(
        screen.getByRole("button", { name: /continue/i }),
      ).toBeInTheDocument();
    });

    it("renders the Pro Agent run cap notice and continues with Standard when premium continuation is unavailable", () => {
      const onContinue = jest.fn();
      renderNotice(
        {
          finishReason: "agent-run-spend-cap",
          mode: "agent",
          agentRunSpendCapPremiumContinuationAllowed: false,
          onContinue,
        },
        { isAutoResuming: false, autoContinueCount: 0 },
      );

      expect(
        screen.getByText(/Paused at the Pro Agent per-run safety cap/i),
      ).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: /continue with standard/i }),
      );

      expect(onContinue).toHaveBeenCalledWith("hackerai-standard");
    });

    it("keeps the current selected model when spend-cap continuation eligibility is unknown", () => {
      const onContinue = jest.fn();
      renderNotice(
        {
          finishReason: "agent-run-spend-cap",
          mode: "agent",
          onContinue,
        },
        { isAutoResuming: false, autoContinueCount: 0 },
      );

      fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));

      expect(onContinue).toHaveBeenCalledWith(undefined);
    });

    it("continues the current premium model when spend-cap continuation is backed by extra usage", () => {
      const onContinue = jest.fn();
      renderNotice(
        {
          finishReason: "agent-run-spend-cap",
          mode: "agent",
          agentRunSpendCapPremiumContinuationAllowed: true,
          onContinue,
        },
        { isAutoResuming: false, autoContinueCount: 0 },
      );

      fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));

      expect(onContinue).toHaveBeenCalledWith(undefined);
    });

    it("renders a usage guardrail notice without a Continue button for budget exhaustion", () => {
      const onContinue = jest.fn();
      renderNotice(
        {
          finishReason: "budget-exhausted",
          mode: "agent",
          onContinue,
        },
        { isAutoResuming: false, autoContinueCount: MAX_AUTO_CONTINUES },
      );

      expect(
        screen.getByText(/Stopped at a usage guardrail for this run/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /continue/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe("correct styling", () => {
    it("renders with the expected CSS classes on the outer and inner divs", () => {
      renderNotice(
        { finishReason: "length", mode: "agent" },
        { isAutoResuming: false, autoContinueCount: MAX_AUTO_CONTINUES },
      );

      const innerDiv = screen
        .getByText(/Reached the output limit for this turn/)
        .closest("div.bg-muted");
      expect(innerDiv).toBeInTheDocument();
      expect(innerDiv).toHaveClass(
        "bg-muted",
        "text-muted-foreground",
        "rounded-lg",
        "px-3",
        "py-2",
        "border",
        "border-border",
      );

      const outerDiv = innerDiv?.parentElement;
      expect(outerDiv).toHaveClass("mt-2", "w-full");
    });
  });
});
