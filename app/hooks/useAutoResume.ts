"use client";

import { useEffect, useRef } from "react";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatMessage } from "@/types/chat";
import {
  useDataStreamState,
  useDataStreamDispatch,
} from "@/app/components/DataStreamProvider";

export interface UseAutoResumeParams {
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

export function useAutoResume({
  autoResume,
  initialMessages,
  resumeStream,
  setMessages,
  hasActiveStream,
}: UseAutoResumeParams) {
  const { dataStream } = useDataStreamState();
  const { setIsAutoResuming } = useDataStreamDispatch();
  const hasAutoResumedRef = useRef(false);

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
    if (!dataStream) return;
    if (dataStream.length === 0) return;

    const dataPart = dataStream[0];
    if (dataPart.type === "data-appendMessage") {
      const message = JSON.parse(dataPart.data);
      setMessages([...initialMessages, message]);
      // First message arrived, we can allow Stop button again
      setIsAutoResuming(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataStream, initialMessages, setMessages]);
}
