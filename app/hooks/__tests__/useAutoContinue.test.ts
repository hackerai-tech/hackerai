import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { renderHook, act } from "@testing-library/react";

const mockSetIsAutoResuming = jest.fn();
const mockState = { dataStream: [] as Array<{ type: string }> };

const mockSetAutoContinueCount = jest.fn();

jest.mock("@/app/components/DataStreamProvider", () => ({
  useDataStream: () => ({
    dataStream: mockState.dataStream,
    setIsAutoResuming: mockSetIsAutoResuming,
    setAutoContinueCount: mockSetAutoContinueCount,
    isAutoResuming: false,
    autoContinueCount: 0,
  }),
}));

import { useAutoContinue } from "../useAutoContinue";
import type { UseAutoContinueParams } from "../useAutoContinue";

describe("useAutoContinue", () => {
  const mockSendMessage = jest.fn();
  const hasManuallyStoppedRef = { current: false };

  const defaultParams: UseAutoContinueParams = {
    status: "ready" as const,
    chatMode: "agent",
    sendMessage: mockSendMessage,
    hasManuallyStoppedRef,
    todos: [],
    temporaryChatsEnabled: false,
    sandboxPreference: "e2b",
    selectedModel: "auto",
  };

  beforeEach(() => {
    mockState.dataStream = [];
    hasManuallyStoppedRef.current = false;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("calls setIsAutoResuming(true) when data-auto-continue is detected in data stream", () => {
    const { rerender } = renderHook(
      (props: UseAutoContinueParams) => useAutoContinue(props),
      { initialProps: { ...defaultParams, status: "streaming" as const } },
    );

    mockState.dataStream = [{ type: "data-auto-continue" }];
    rerender({ ...defaultParams, status: "streaming" as const });

    expect(mockSetIsAutoResuming).toHaveBeenCalledWith(true);
  });

  it("sends message with isAutoContinue: true in body when auto-continue triggers", () => {
    const { rerender } = renderHook(
      (props: UseAutoContinueParams) => useAutoContinue(props),
      { initialProps: { ...defaultParams, status: "streaming" as const } },
    );

    mockState.dataStream = [{ type: "data-auto-continue" }];
    rerender({ ...defaultParams, status: "streaming" as const });

    expect(mockSetIsAutoResuming).toHaveBeenCalledWith(true);

    rerender({ ...defaultParams, status: "ready" as const });

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(mockSendMessage).toHaveBeenCalledWith(
      { text: "continue" },
      {
        body: expect.objectContaining({
          isAutoContinue: true,
          mode: "agent",
        }),
      },
    );
  });

  it("calls setIsAutoResuming(false) when status changes to streaming", () => {
    const { rerender } = renderHook(
      (props: UseAutoContinueParams) => useAutoContinue(props),
      { initialProps: { ...defaultParams, status: "ready" as const } },
    );

    mockSetIsAutoResuming.mockClear();

    rerender({ ...defaultParams, status: "streaming" as const });

    expect(mockSetIsAutoResuming).toHaveBeenCalledWith(false);
  });

  it("does not trigger auto-continue when chatMode is not agent", () => {
    const { rerender } = renderHook(
      (props: UseAutoContinueParams) => useAutoContinue(props),
      {
        initialProps: {
          ...defaultParams,
          chatMode: "ask",
          status: "streaming" as const,
        },
      },
    );

    mockState.dataStream = [{ type: "data-auto-continue" }];
    rerender({
      ...defaultParams,
      chatMode: "ask",
      status: "streaming" as const,
    });

    rerender({ ...defaultParams, chatMode: "ask", status: "ready" as const });

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("does not trigger auto-continue when manually stopped", () => {
    hasManuallyStoppedRef.current = true;

    const { rerender } = renderHook(
      (props: UseAutoContinueParams) => useAutoContinue(props),
      { initialProps: { ...defaultParams, status: "streaming" as const } },
    );

    mockState.dataStream = [{ type: "data-auto-continue" }];
    rerender({ ...defaultParams, status: "streaming" as const });

    rerender({ ...defaultParams, status: "ready" as const });

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("includes todos, temporary, sandboxPreference and selectedModel in body", () => {
    const params: UseAutoContinueParams = {
      ...defaultParams,
      status: "streaming" as const,
      todos: [{ id: "1", content: "Test todo", status: "pending" }],
      temporaryChatsEnabled: true,
      sandboxPreference: "local-123",
      selectedModel: "sonnet-4.6",
    };

    const { rerender } = renderHook(
      (props: UseAutoContinueParams) => useAutoContinue(props),
      { initialProps: params },
    );

    mockState.dataStream = [{ type: "data-auto-continue" }];
    rerender(params);

    rerender({
      ...params,
      status: "ready" as const,
    });

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(mockSendMessage).toHaveBeenCalledWith(
      { text: "continue" },
      {
        body: {
          mode: "agent",
          isAutoContinue: true,
          todos: [{ id: "1", content: "Test todo", status: "pending" }],
          temporary: true,
          sandboxPreference: "local-123",
          selectedModel: "sonnet-4.6",
        },
      },
    );
  });

  it("resets isAutoResuming when MAX_AUTO_CONTINUES is reached", () => {
    const { rerender } = renderHook(
      (props: UseAutoContinueParams) => useAutoContinue(props),
      { initialProps: { ...defaultParams, status: "streaming" as const } },
    );

    // Trigger 5 auto-continues to exhaust the limit
    for (let i = 0; i < 5; i++) {
      mockState.dataStream = [
        ...mockState.dataStream,
        { type: "data-auto-continue" },
      ];
      rerender({ ...defaultParams, status: "streaming" as const });

      rerender({ ...defaultParams, status: "ready" as const });
      act(() => {
        jest.advanceTimersByTime(500);
      });

      // Reset status back to streaming for next iteration
      if (i < 4) {
        rerender({ ...defaultParams, status: "streaming" as const });
      }
    }

    expect(mockSendMessage).toHaveBeenCalledTimes(5);
    mockSetIsAutoResuming.mockClear();

    // 6th auto-continue signal — should hit the limit
    mockState.dataStream = [
      ...mockState.dataStream,
      { type: "data-auto-continue" },
    ];
    rerender({ ...defaultParams, status: "streaming" as const });

    rerender({ ...defaultParams, status: "ready" as const });
    act(() => {
      jest.advanceTimersByTime(500);
    });

    // Should NOT send a 6th message
    expect(mockSendMessage).toHaveBeenCalledTimes(5);
    // Should reset isAutoResuming so FinishReasonNotice shows
    expect(mockSetIsAutoResuming).toHaveBeenCalledWith(false);
  });

  it("triggers auto-continue when data-auto-continue arrives after status is already ready", () => {
    // This replicates the real scenario: writeAutoContinue is called in onFinish
    // on the server, so the data-auto-continue SSE event arrives AFTER the stream
    // ends and status has already transitioned to "ready".
    const { rerender } = renderHook(
      (props: UseAutoContinueParams) => useAutoContinue(props),
      { initialProps: { ...defaultParams, status: "streaming" as const } },
    );

    // Stream ends — status transitions to "ready" BEFORE signal arrives
    rerender({ ...defaultParams, status: "ready" as const });

    // Now the data-auto-continue signal arrives (late, after stream ended)
    mockState.dataStream = [{ type: "data-auto-continue" }];
    rerender({ ...defaultParams, status: "ready" as const });

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(mockSendMessage).toHaveBeenCalledWith(
      { text: "continue" },
      {
        body: expect.objectContaining({
          isAutoContinue: true,
          mode: "agent",
        }),
      },
    );
  });

  it("resets auto-continue count via resetAutoContinueCount", () => {
    const { result } = renderHook(
      (props: UseAutoContinueParams) => useAutoContinue(props),
      { initialProps: defaultParams },
    );

    expect(result.current.resetAutoContinueCount).toBeDefined();
    expect(typeof result.current.resetAutoContinueCount).toBe("function");

    act(() => {
      result.current.resetAutoContinueCount();
    });
  });
});
