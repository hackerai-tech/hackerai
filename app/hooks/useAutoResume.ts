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
  if (currentMessages.some((message) => message.id === resumedMessage.id)) {
    return currentMessages;
  }
  if (initialMessages.some((message) => message.id === resumedMessage.id)) {
    return initialMessages;
  }

  return [
    ...(currentMessages.length > initialMessages.length
      ? currentMessages
      : initialMessages),
    resumedMessage,
  ];
}

export function useAutoResume({
  chatId,
  autoResume,
  initialMessages,
  resumeStream,
  setMessages,
  hasActiveStream,
}: UseAutoResumeParams) {
  const { dataStream } = useDataStreamState();
  const { setIsAutoResuming } = useDataStreamDispatch();
  const hasAutoResumedRef = useRef(false);

  const isPartForCurrentChat = (part: ScopedDataUIPart) =>
    part.__chatId === undefined || part.__chatId === chatId;

  useEffect(() => {
    hasAutoResumedRef.current = false;
  }, [chatId]);

  useEffect(() => {
    if (!autoResume || hasAutoResumedRef.current) return;
    if (initialMessages.length === 0) return;
    // Wait for chat data to load, then only resume when the server says
    // it's actively producing a response.
    if (hasActiveStream === undefined) return;
    if (!hasActiveStream) return;

    const mostRecentMessage = initialMessages.at(-1);

    if (mostRecentMessage?.role === "user") {
      hasAutoResumedRef.current = true;
      setIsAutoResuming(true);
      resumeStream();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoResume, initialMessages.length > 0, hasActiveStream]);

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
