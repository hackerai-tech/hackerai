"use client";

import { useEffect, useRef, useCallback } from "react";
import type { ChatStatus, Todo } from "@/types";
import { useDataStream } from "@/app/components/DataStreamProvider";
import { useLatestRef } from "./useLatestRef";

export const MAX_AUTO_CONTINUES = 5;

export interface UseAutoContinueParams {
  status: ChatStatus;
  chatMode: string;
  sendMessage: (
    message: { text: string },
    options?: { body?: Record<string, unknown> },
  ) => void;
  hasManuallyStoppedRef: React.RefObject<boolean>;
  todos: Todo[];
  temporaryChatsEnabled: boolean;
  sandboxPreference: string;
  selectedModel: string;
}

export function useAutoContinue({
  status,
  chatMode,
  sendMessage,
  hasManuallyStoppedRef,
  todos,
  temporaryChatsEnabled,
  sandboxPreference,
  selectedModel,
}: UseAutoContinueParams) {
  const { dataStream, setIsAutoResuming, setAutoContinueCount } =
    useDataStream();
  const autoContinueCountRef = useRef(0);
  const pendingAutoContinueRef = useRef(false);
  const lastProcessedIndexRef = useRef(0);

  const todosRef = useLatestRef(todos);
  const sendMessageRef = useLatestRef(sendMessage);
  const temporaryChatsEnabledRef = useLatestRef(temporaryChatsEnabled);
  const sandboxPreferenceRef = useLatestRef(sandboxPreference);
  const selectedModelRef = useLatestRef(selectedModel);

  // Detect data-auto-continue signal and immediately mark pending
  useEffect(() => {
    if (!dataStream?.length) return;
    const newParts = dataStream.slice(lastProcessedIndexRef.current);
    if (newParts.some((part) => part.type === "data-auto-continue")) {
      pendingAutoContinueRef.current = true;
      setIsAutoResuming(true);
    }
    lastProcessedIndexRef.current = dataStream.length;
  }, [dataStream, setIsAutoResuming]);

  // Fire auto-continue when status is ready and signal was detected.
  // Depends on both `status` and `dataStream` so it re-evaluates when
  // the signal arrives after the stream has already ended (status already "ready").
  useEffect(() => {
    if (status !== "ready" || !pendingAutoContinueRef.current) return;
    if (hasManuallyStoppedRef.current) return;
    if (chatMode !== "agent") return;
    if (autoContinueCountRef.current >= MAX_AUTO_CONTINUES) {
      setIsAutoResuming(false);
      return;
    }

    pendingAutoContinueRef.current = false;
    autoContinueCountRef.current += 1;
    setAutoContinueCount(autoContinueCountRef.current);

    const timeout = setTimeout(() => {
      sendMessageRef.current(
        { text: "continue" },
        {
          body: {
            mode: chatMode,
            isAutoContinue: true,
            todos: todosRef.current,
            temporary: temporaryChatsEnabledRef.current,
            sandboxPreference: sandboxPreferenceRef.current,
            selectedModel: selectedModelRef.current,
          },
        },
      );
    }, 500);

    return () => clearTimeout(timeout);
  }, [
    status,
    dataStream,
    chatMode,
    hasManuallyStoppedRef,
    setIsAutoResuming,
    sendMessageRef,
    todosRef,
    temporaryChatsEnabledRef,
    sandboxPreferenceRef,
    selectedModelRef,
  ]);

  useEffect(() => {
    if (status === "streaming") {
      setIsAutoResuming(false);
    }
  }, [status, setIsAutoResuming]);

  const resetAutoContinueCount = useCallback(() => {
    autoContinueCountRef.current = 0;
    pendingAutoContinueRef.current = false;
    setAutoContinueCount(0);
  }, [setAutoContinueCount]);

  return { resetAutoContinueCount };
}
