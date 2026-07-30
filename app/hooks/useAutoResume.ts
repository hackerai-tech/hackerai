"use client";

import { useEffect, useRef } from "react";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatMessage } from "@/types/chat";
import {
  useDataStreamState,
  useDataStreamDispatch,
  type ScopedDataUIPart,
} from "@/app/components/DataStreamProvider";

export interface UseAutoResumeParams {
  chatId: string;
  autoResume: boolean;
  initialMessages: ChatMessage[];
  resumeStream: UseChatHelpers<ChatMessage>["resumeStream"];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  status: UseChatHelpers<ChatMessage>["status"];
  // Tri-state: undefined = chat data still loading (wait), true = server is
  // actively producing (resume), false = no active stream (don't resume —
  // the user message went unanswered, but resuming would just GET an empty
  // SSE and waste a round-trip).
  hasActiveStream: boolean | undefined;
}

export function mergeResumedMessage(
  currentMessages: ChatMessage[],
  initialMessages: ChatMessage[],
  resumedMessage: ChatMessage,
): ChatMessage[] {
  const baseMessages =
    currentMessages.length > 0 ? currentMessages : initialMessages;

  if (baseMessages.some((message) => message.id === resumedMessage.id)) {
    return baseMessages;
  }

  return [...baseMessages, resumedMessage];
}

export function useAutoResume({
  chatId,
  autoResume,
  initialMessages,
  resumeStream,
  setMessages,
  status,
  hasActiveStream,
}: UseAutoResumeParams) {
  const { dataStream } = useDataStreamState();
  const { setIsAutoResuming } = useDataStreamDispatch();
  const hasAutoResumedRef = useRef(false);
  const hasEvaluatedInitialResumeRef = useRef(false);
  const hasLocalRequestStartedRef = useRef(false);

  const isPartForCurrentChat = (part: ScopedDataUIPart) =>
    part.__chatId === undefined || part.__chatId === chatId;

  useEffect(() => {
    hasAutoResumedRef.current = false;
    hasEvaluatedInitialResumeRef.current = false;
    hasLocalRequestStartedRef.current = false;
  }, [chatId]);

  useEffect(() => {
    if (status !== "ready") {
      hasLocalRequestStartedRef.current = true;
    }
  }, [status]);

  useEffect(() => {
    if (!autoResume || hasEvaluatedInitialResumeRef.current) return;
    if (hasActiveStream === undefined) return;

    // Auto-resume is a one-time hydration decision. Once the initial server
    // state says there is no active stream, a later local request must not
    // become eligible when it publishes its own active run id.
    if (!hasActiveStream) {
      hasEvaluatedInitialResumeRef.current = true;
      return;
    }

    if (initialMessages.length === 0) return;

    hasEvaluatedInitialResumeRef.current = true;
    if (status !== "ready" || hasLocalRequestStartedRef.current) return;

    const mostRecentMessage = initialMessages.at(-1);

    if (mostRecentMessage?.role === "user") {
      hasAutoResumedRef.current = true;
      setIsAutoResuming(true);
      resumeStream();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoResume, initialMessages.length > 0, hasActiveStream, status]);

  useEffect(() => {
    if (!autoResume || !hasAutoResumedRef.current) return;
    if (!dataStream) return;
    if (dataStream.length === 0) return;

    const dataPart = dataStream.find(
      (part) =>
        isPartForCurrentChat(part) && part.type === "data-appendMessage",
    );
    if (!dataPart) return;
    if (dataPart.type === "data-appendMessage") {
      const message = JSON.parse(dataPart.data);
      setMessages((currentMessages) =>
        mergeResumedMessage(currentMessages, initialMessages, message),
      );
      // First message arrived, we can allow Stop button again
      setIsAutoResuming(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoResume, dataStream, initialMessages, setMessages]);
}
