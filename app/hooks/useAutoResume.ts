"use client";

import { useEffect, useRef } from "react";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatMessage } from "@/types/chat";
import { useDataStream } from "@/app/components/DataStreamProvider";

export interface UseAutoResumeParams {
  autoResume: boolean;
  initialMessages: ChatMessage[];
  resumeStream: UseChatHelpers<ChatMessage>["resumeStream"];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
}

export function useAutoResume({
  autoResume,
  initialMessages,
  resumeStream,
  setMessages,
}: UseAutoResumeParams) {
  const { dataStream, setIsAutoResuming } = useDataStream();
  const hasAttemptedRef = useRef(false);

  useEffect(() => {
    if (!autoResume) return;
    if (hasAttemptedRef.current) return;

    const mostRecentMessage = initialMessages.at(-1);
    const shouldResume = mostRecentMessage?.role === "user";

    if (shouldResume) {
      hasAttemptedRef.current = true;
      setIsAutoResuming(true);
      resumeStream();
    }
  }, [autoResume, initialMessages, resumeStream]);

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
  }, [dataStream, initialMessages, setMessages]);
}
