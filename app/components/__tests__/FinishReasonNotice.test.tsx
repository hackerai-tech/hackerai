import "@testing-library/jest-dom";
import { describe, it, expect } from "@jest/globals";
import React from "react";
import { render, screen } from "@testing-library/react";
import { FinishReasonNotice } from "../FinishReasonNotice";
import { DataStreamProvider, useDataStream } from "../DataStreamProvider";
import { MAX_AUTO_CONTINUES } from "@/app/hooks/useAutoContinue";
import type { ChatMode } from "@/types/chat";

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
        expectedText: "I automatically stopped to prevent going off course",
      },
      {
        finishReason: "timeout",
        expectedText: "I had to stop due to the time limit",
      },
      {
        finishReason: "length",
        expectedText: "I hit the output token limit and had to stop",
      },
      {
        finishReason: "context-limit",
        expectedText:
          "I reached the context limit for this conversation after summarizing",
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
        expectedText:
          "I reached the context limit for this conversation after summarizing",
      },
      {
        finishReason: "length",
        mode: "ask" as ChatMode,
        expectedText: "I hit the output token limit and had to stop",
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

    it("renders tool-calls notice in agent mode even with autoContinueCount=0 (tool-calls is not auto-continuable)", () => {
      renderNotice(
        { finishReason: "tool-calls", mode: "agent" },
        { isAutoResuming: false, autoContinueCount: 0 },
      );
      expect(
        screen.getByText(/I automatically stopped to prevent going off course/),
      ).toBeInTheDocument();
    });

    it("renders timeout notice in agent mode even with autoContinueCount=0 (timeout is not auto-continuable)", () => {
      renderNotice(
        { finishReason: "timeout", mode: "agent" },
        { isAutoResuming: false, autoContinueCount: 0 },
      );
      expect(
        screen.getByText(/I had to stop due to the time limit/),
      ).toBeInTheDocument();
    });
  });

  describe("correct styling", () => {
    it("renders with the expected CSS classes on the outer and inner divs", () => {
      renderNotice(
        { finishReason: "length", mode: "agent" },
        { isAutoResuming: false, autoContinueCount: MAX_AUTO_CONTINUES },
      );

      const innerDiv = screen
        .getByText(/I hit the output token limit/)
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
