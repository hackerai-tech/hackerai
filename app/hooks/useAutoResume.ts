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
  const hasAutoResumedRef = useRef(false);

  useEffect(() => {
    if (!autoResume || hasAutoResumedRef.current) return;
    if (initialMessages.length === 0) return;

    const mostRecentMessage = initialMessages.at(-1);

    if (mostRecentMessage?.role === "user") {
      hasAutoResumedRef.current = true;
      setIsAutoResuming(true);
      resumeStream();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoResume, initialMessages.length > 0]);

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
