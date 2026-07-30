import React from "react";
import { renderHook } from "@testing-library/react";
import {
  DataStreamProvider,
  useDataStream,
} from "@/app/components/DataStreamProvider";
import {
  mergeResumedMessage,
  useAutoResume,
  type UseAutoResumeParams,
} from "../useAutoResume";
import type { ChatMessage } from "@/types/chat";

function message(id: string, role: "user" | "assistant"): ChatMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text: id }],
  } as ChatMessage;
}

function createWrapper() {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(DataStreamProvider, null, children);
  };
}

function buildParams(
  overrides: Partial<UseAutoResumeParams> = {},
): UseAutoResumeParams {
  return {
    chatId: "chat-1",
    autoResume: true,
    initialMessages: [message("user-1", "user")],
    resumeStream: jest.fn(),
    setMessages: jest.fn(),
    status: "ready",
    hasActiveStream: true,
    ...overrides,
  };
}

function useTestHarness(params: UseAutoResumeParams) {
  useAutoResume(params);
  return useDataStream();
}

describe("mergeResumedMessage", () => {
  it("does not duplicate a resumed message already in current state", () => {
    const currentMessages = [
      message("user-1", "user"),
      message("a-1", "assistant"),
    ];
    const result = mergeResumedMessage(
      currentMessages,
      [message("user-1", "user")],
      message("a-1", "assistant"),
    );

    expect(result).toBe(currentMessages);
  });

  it("does not duplicate a resumed message already in initial messages before current state exists", () => {
    const initialMessages = [
      message("user-1", "user"),
      message("a-1", "assistant"),
    ];
    const result = mergeResumedMessage(
      [],
      initialMessages,
      message("a-1", "assistant"),
    );

    expect(result).toBe(initialMessages);
  });

  it("appends to current messages when current state has already hydrated", () => {
    const currentMessages = [
      message("user-1", "user"),
      message("a-1", "assistant"),
    ];
    const result = mergeResumedMessage(
      currentMessages,
      [message("user-1", "user")],
      message("a-2", "assistant"),
    );

    expect(result.map((item) => item.id)).toEqual(["user-1", "a-1", "a-2"]);
  });

  it("keeps current messages as the source of truth even when initial messages contain the resumed id", () => {
    const currentMessages = [message("user-1", "user")];
    const result = mergeResumedMessage(
      currentMessages,
      [message("user-1", "user"), message("a-1", "assistant")],
      message("a-1", "assistant"),
    );

    expect(result.map((item) => item.id)).toEqual(["user-1", "a-1"]);
  });
});

describe("useAutoResume", () => {
  it("resumes a stream that was active when the chat loaded", () => {
    const resumeStream = jest.fn();
    const params = buildParams({ resumeStream });

    const { result } = renderHook(() => useTestHarness(params), {
      wrapper: createWrapper(),
    });

    expect(resumeStream).toHaveBeenCalledTimes(1);
    expect(result.current.isAutoResuming).toBe(true);
  });

  it("does not resume a stream that becomes active after initial load", () => {
    const resumeStream = jest.fn();
    let params = buildParams({
      resumeStream,
      hasActiveStream: false,
    });

    const { rerender } = renderHook(
      (nextParams: UseAutoResumeParams) => useTestHarness(nextParams),
      {
        initialProps: params,
        wrapper: createWrapper(),
      },
    );

    params = { ...params, hasActiveStream: true };
    rerender(params);

    expect(resumeStream).not.toHaveBeenCalled();
  });

  it("does not reconsider a completed initial chat after a new user message", () => {
    const resumeStream = jest.fn();
    let params = buildParams({
      resumeStream,
      initialMessages: [message("assistant-1", "assistant")],
    });

    const { rerender } = renderHook(
      (nextParams: UseAutoResumeParams) => useTestHarness(nextParams),
      {
        initialProps: params,
        wrapper: createWrapper(),
      },
    );

    params = {
      ...params,
      initialMessages: [
        message("assistant-1", "assistant"),
        message("user-2", "user"),
      ],
    };
    rerender(params);

    expect(resumeStream).not.toHaveBeenCalled();
  });

  it.each(["submitted", "streaming"] as const)(
    "does not resume while a local request is %s",
    (status) => {
      const resumeStream = jest.fn();
      let params = buildParams({ resumeStream, status });

      const { rerender } = renderHook(
        (nextParams: UseAutoResumeParams) => useTestHarness(nextParams),
        {
          initialProps: params,
          wrapper: createWrapper(),
        },
      );

      params = { ...params, status: "ready" };
      rerender(params);

      expect(resumeStream).not.toHaveBeenCalled();
    },
  );

  it("waits for the initial server stream state before resuming", () => {
    const resumeStream = jest.fn();
    let params = buildParams({
      resumeStream,
      hasActiveStream: undefined,
    });

    const { rerender } = renderHook(
      (nextParams: UseAutoResumeParams) => useTestHarness(nextParams),
      {
        initialProps: params,
        wrapper: createWrapper(),
      },
    );

    expect(resumeStream).not.toHaveBeenCalled();

    params = { ...params, hasActiveStream: true };
    rerender(params);

    expect(resumeStream).toHaveBeenCalledTimes(1);
  });
});
