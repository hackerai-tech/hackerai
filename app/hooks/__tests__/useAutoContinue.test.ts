import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import React from "react";
import { renderHook, act } from "@testing-library/react";
import {
  DataStreamProvider,
  useDataStream,
} from "@/app/components/DataStreamProvider";
import {
  AUTO_CONTINUE_PROMPT,
  useAutoContinue,
  MAX_AUTO_CONTINUES,
} from "../useAutoContinue";
import type { UseAutoContinueParams } from "../useAutoContinue";

type DataStreamEntry = { type: string; data?: unknown; __chatId?: string };

function useTestHarness(params: UseAutoContinueParams) {
  const autoContinue = useAutoContinue(params);
  const { setDataStream, isAutoResuming, isAutoContinuing, autoContinueCount } =
    useDataStream();
  return {
    ...autoContinue,
    setDataStream,
    isAutoResuming,
    isAutoContinuing,
    autoContinueCount,
  };
}

function createWrapper() {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(DataStreamProvider, null, children);
  };
}

function buildParams(
  overrides: Partial<UseAutoContinueParams> = {},
): UseAutoContinueParams {
  return {
    chatId: "chat-1",
    status: "ready",
    chatMode: "agent",
    sendMessage: jest.fn(),
    hasManuallyStoppedRef: { current: false },
    todos: [],
    temporaryChatsEnabled: false,
    sandboxPreference: "e2b",
    agentPermissionMode: "full_access",
    selectedModel: "auto",
    ...overrides,
  };
}

function pushAutoContinue(
  result: { current: ReturnType<typeof useTestHarness> },
  previous: DataStreamEntry[] = [],
): DataStreamEntry[] {
  const updated = [...previous, { type: "data-auto-continue", data: {} }];
  act(() => {
    result.current.setDataStream(updated as any);
  });
  return updated;
}

describe("useAutoContinue", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("sets isAutoResuming to true when data-auto-continue arrives", () => {
    const params = buildParams({ status: "streaming" });
    const { result } = renderHook(() => useTestHarness(params), {
      wrapper: createWrapper(),
    });

    expect(result.current.isAutoResuming).toBe(false);

    pushAutoContinue(result);

    expect(result.current.isAutoResuming).toBe(true);
    expect(result.current.isAutoContinuing).toBe(true);
  });

  it("ignores data-auto-continue from another chat", () => {
    const sendMessage = jest.fn();
    let params = buildParams({ status: "streaming", sendMessage });
    const { result, rerender } = renderHook(
      (p: UseAutoContinueParams) => useTestHarness(p),
      { initialProps: params, wrapper: createWrapper() },
    );

    act(() => {
      result.current.setDataStream([
        { type: "data-auto-continue", data: {}, __chatId: "other-chat" },
      ] as any);
    });

    expect(result.current.isAutoResuming).toBe(false);

    params = { ...params, status: "ready" };
    rerender(params);
    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.current.isAutoContinuing).toBe(false);
  });

  it("sends message with full body when signal arrives during streaming then status becomes ready", () => {
    const sendMessage = jest.fn();
    const todos = [{ id: "1", content: "Test", status: "pending" as const }];
    let params = buildParams({
      status: "streaming",
      sendMessage,
      todos,
      temporaryChatsEnabled: true,
      sandboxPreference: "local-123",
      selectedModel: "sonnet-4.6",
    });

    const { result, rerender } = renderHook(
      (p: UseAutoContinueParams) => useTestHarness(p),
      { initialProps: params, wrapper: createWrapper() },
    );

    pushAutoContinue(result);

    params = { ...params, status: "ready" };
    rerender(params);

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      {
        text: AUTO_CONTINUE_PROMPT,
        metadata: { isAutoContinue: true },
      },
      {
        body: {
          mode: "agent",
          isAutoContinue: true,
          todos,
          temporary: true,
          sandboxPreference: "local-123",
          agentPermissionMode: "full_access",
          selectedModel: "sonnet-4.6",
        },
      },
    );
  });

  it("fires auto-continue when data-auto-continue arrives after status is already ready", () => {
    const sendMessage = jest.fn();
    let params = buildParams({ status: "streaming", sendMessage });

    const { result, rerender } = renderHook(
      (p: UseAutoContinueParams) => useTestHarness(p),
      { initialProps: params, wrapper: createWrapper() },
    );

    params = { ...params, status: "ready" };
    rerender(params);

    pushAutoContinue(result);

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      {
        text: AUTO_CONTINUE_PROMPT,
        metadata: { isAutoContinue: true },
      },
      {
        body: expect.objectContaining({
          isAutoContinue: true,
          mode: "agent",
        }),
      },
    );
  });

  it.each([
    {
      label: "chatMode is not agent",
      override: { chatMode: "ask" },
    },
    {
      label: "hasManuallyStoppedRef is true",
      override: { hasManuallyStoppedRef: { current: true } },
    },
  ])("does not fire auto-continue when $label", ({ override }) => {
    const sendMessage = jest.fn();
    let params = buildParams({
      status: "streaming",
      sendMessage,
      ...override,
    });

    const { result, rerender } = renderHook(
      (p: UseAutoContinueParams) => useTestHarness(p),
      { initialProps: params, wrapper: createWrapper() },
    );

    pushAutoContinue(result);

    params = { ...params, status: "ready" };
    rerender(params);

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("stops firing after MAX_AUTO_CONTINUES and resets isAutoResuming", () => {
    const sendMessage = jest.fn();
    let params = buildParams({ status: "streaming", sendMessage });
    let stream: DataStreamEntry[] = [];

    const { result, rerender } = renderHook(
      (p: UseAutoContinueParams) => useTestHarness(p),
      { initialProps: params, wrapper: createWrapper() },
    );

    for (let i = 0; i < MAX_AUTO_CONTINUES; i++) {
      params = { ...params, status: "streaming" };
      rerender(params);

      stream = pushAutoContinue(result, stream);

      params = { ...params, status: "ready" };
      rerender(params);

      act(() => {
        jest.advanceTimersByTime(500);
      });
    }

    expect(sendMessage).toHaveBeenCalledTimes(MAX_AUTO_CONTINUES);

    params = { ...params, status: "streaming" };
    rerender(params);

    stream = pushAutoContinue(result, stream);

    params = { ...params, status: "ready" };
    rerender(params);

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(sendMessage).toHaveBeenCalledTimes(MAX_AUTO_CONTINUES);
    expect(result.current.isAutoResuming).toBe(false);
    expect(result.current.isAutoContinuing).toBe(false);
  });

  it("increments autoContinueCount in context after each auto-continue", () => {
    const sendMessage = jest.fn();
    let params = buildParams({ status: "streaming", sendMessage });
    let stream: DataStreamEntry[] = [];

    const { result, rerender } = renderHook(
      (p: UseAutoContinueParams) => useTestHarness(p),
      { initialProps: params, wrapper: createWrapper() },
    );

    expect(result.current.autoContinueCount).toBe(0);

    for (let i = 1; i <= 3; i++) {
      params = { ...params, status: "streaming" };
      rerender(params);

      stream = pushAutoContinue(result, stream);

      params = { ...params, status: "ready" };
      rerender(params);

      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(result.current.autoContinueCount).toBe(i);
    }
  });

  it("resets autoContinueCount to 0 via resetAutoContinueCount", () => {
    const sendMessage = jest.fn();
    let params = buildParams({ status: "streaming", sendMessage });

    const { result, rerender } = renderHook(
      (p: UseAutoContinueParams) => useTestHarness(p),
      { initialProps: params, wrapper: createWrapper() },
    );

    pushAutoContinue(result);

    params = { ...params, status: "ready" };
    rerender(params);

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(result.current.autoContinueCount).toBe(1);
    expect(result.current.isAutoContinuing).toBe(true);

    act(() => {
      result.current.resetAutoContinueCount();
    });

    expect(result.current.autoContinueCount).toBe(0);
    expect(result.current.isAutoContinuing).toBe(false);
  });

  it("keeps automatic continuation active until the follow-up run settles", () => {
    const sendMessage = jest.fn();
    let params = buildParams({ status: "streaming", sendMessage });

    const { result, rerender } = renderHook(
      (p: UseAutoContinueParams) => useTestHarness(p),
      { initialProps: params, wrapper: createWrapper() },
    );

    pushAutoContinue(result);

    params = { ...params, status: "ready" };
    rerender(params);
    act(() => {
      jest.advanceTimersByTime(500);
    });

    params = { ...params, status: "submitted" };
    rerender(params);
    expect(result.current.isAutoContinuing).toBe(true);

    params = { ...params, status: "streaming" };
    rerender(params);
    expect(result.current.isAutoContinuing).toBe(true);

    params = { ...params, status: "ready" };
    rerender(params);
    act(() => {
      jest.advanceTimersByTime(249);
    });
    expect(result.current.isAutoContinuing).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.isAutoContinuing).toBe(false);
  });

  it("clears automatic continuation and its pending signal on error", () => {
    const sendMessage = jest.fn();
    let params = buildParams({ status: "streaming", sendMessage });

    const { result, rerender } = renderHook(
      (p: UseAutoContinueParams) => useTestHarness(p),
      { initialProps: params, wrapper: createWrapper() },
    );

    pushAutoContinue(result);
    expect(result.current.isAutoContinuing).toBe(true);

    params = { ...params, status: "error" };
    rerender(params);

    expect(result.current.isAutoContinuing).toBe(false);
    expect(result.current.isAutoResuming).toBe(false);

    params = { ...params, status: "ready" };
    rerender(params);
    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("resets isAutoResuming to false when status transitions to streaming", () => {
    let params = buildParams({ status: "streaming" });

    const { result, rerender } = renderHook(
      (p: UseAutoContinueParams) => useTestHarness(p),
      { initialProps: params, wrapper: createWrapper() },
    );

    pushAutoContinue(result);
    expect(result.current.isAutoResuming).toBe(true);

    params = { ...params, status: "ready" };
    rerender(params);

    act(() => {
      jest.advanceTimersByTime(500);
    });

    params = { ...params, status: "streaming" };
    rerender(params);

    expect(result.current.isAutoResuming).toBe(false);
  });
});
