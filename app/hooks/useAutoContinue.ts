"use client";

import { useEffect, useRef, useCallback } from "react";
import type { ChatStatus, Todo } from "@/types";
import { useDataStream } from "@/app/components/DataStreamProvider";
import { useLatestRef } from "./useLatestRef";

const MAX_AUTO_CONTINUES = 5;

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
  const { dataStream, setIsAutoResuming } = useDataStream();
  const autoContinueCountRef = useRef(0);
  const pendingAutoContinueRef = useRef(false);
  const lastProcessedIndexRef = useRef(0);

  const todosRef = useLatestRef(todos);
  const sendMessageRef = useLatestRef(sendMessage);
  const temporaryChatsEnabledRef = useLatestRef(temporaryChatsEnabled);
  const sandboxPreferenceRef = useLatestRef(sandboxPreference);
  const selectedModelRef = useLatestRef(selectedModel);

  useEffect(() => {
    if (!dataStream?.length) return;
    const newParts = dataStream.slice(lastProcessedIndexRef.current);
    if (newParts.some((part) => part.type === "data-auto-continue")) {
      pendingAutoContinueRef.current = true;
    }
    lastProcessedIndexRef.current = dataStream.length;
  }, [dataStream]);

  useEffect(() => {
    if (status !== "ready" || !pendingAutoContinueRef.current) return;
    if (hasManuallyStoppedRef.current) return;
    if (chatMode !== "agent") return;
    if (autoContinueCountRef.current >= MAX_AUTO_CONTINUES) return;

    pendingAutoContinueRef.current = false;
    autoContinueCountRef.current += 1;

    const timeout = setTimeout(() => {
      setIsAutoResuming(true);
      sendMessageRef.current(
        { text: "continue" },
        {
          body: {
            mode: chatMode,
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
    chatMode,
    hasManuallyStoppedRef,
    setIsAutoResuming,
    sendMessageRef,
    todosRef,
    temporaryChatsEnabledRef,
    sandboxPreferenceRef,
    selectedModelRef,
  ]);

  const resetAutoContinueCount = useCallback(() => {
    autoContinueCountRef.current = 0;
    pendingAutoContinueRef.current = false;
  }, []);

  return { resetAutoContinueCount };
}
