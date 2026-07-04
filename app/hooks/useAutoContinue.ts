"use client";

import { useEffect, useRef, useCallback } from "react";
import type { ChatStatus, MessageMetadata, Todo } from "@/types";
import {
  useDataStreamState,
  useDataStreamDispatch,
  type ScopedDataUIPart,
} from "@/app/components/DataStreamProvider";
import { useLatestRef } from "./useLatestRef";

export const MAX_AUTO_CONTINUES = 5;
export const AUTO_CONTINUE_PROMPT =
  "Continue from the latest saved progress. Do not restart the original task or repeat completed work.";

export interface UseAutoContinueParams {
  chatId: string;
  status: ChatStatus;
  chatMode: string;
  sendMessage: (
    message: { text: string; metadata?: MessageMetadata },
    options?: { body?: Record<string, unknown> },
  ) => void;
  hasManuallyStoppedRef: React.RefObject<boolean>;
  todos: Todo[];
  temporaryChatsEnabled: boolean;
  sandboxPreference: string;
  agentPermissionMode: string;
  selectedModel: string;
}

export function useAutoContinue({
  chatId,
  status,
  chatMode,
  sendMessage,
  hasManuallyStoppedRef,
  todos,
  temporaryChatsEnabled,
  sandboxPreference,
  agentPermissionMode,
  selectedModel,
}: UseAutoContinueParams) {
  const { dataStream } = useDataStreamState();
  const { setIsAutoResuming, setAutoContinueCount } = useDataStreamDispatch();
  const autoContinueCountRef = useRef(0);
  const pendingAutoContinueRef = useRef(false);
  const lastProcessedIndexRef = useRef(0);

  const todosRef = useLatestRef(todos);
  const sendMessageRef = useLatestRef(sendMessage);
  const temporaryChatsEnabledRef = useLatestRef(temporaryChatsEnabled);
  const sandboxPreferenceRef = useLatestRef(sandboxPreference);
  const agentPermissionModeRef = useLatestRef(agentPermissionMode);
  const selectedModelRef = useLatestRef(selectedModel);
  const isPartForCurrentChat = (part: ScopedDataUIPart) =>
    part.__chatId === undefined || part.__chatId === chatId;

  useEffect(() => {
    pendingAutoContinueRef.current = false;
    lastProcessedIndexRef.current = 0;
  }, [chatId]);

  // Detect data-auto-continue signal and immediately mark pending
  useEffect(() => {
    if (!dataStream?.length) return;
    const currentChatDataStream = dataStream.filter(isPartForCurrentChat);
    const newParts = currentChatDataStream.slice(lastProcessedIndexRef.current);
    if (newParts.some((part) => part.type === "data-auto-continue")) {
      pendingAutoContinueRef.current = true;
      setIsAutoResuming(true);
    }
    lastProcessedIndexRef.current = currentChatDataStream.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        {
          text: AUTO_CONTINUE_PROMPT,
          metadata: { isAutoContinue: true },
        },
        {
          body: {
            mode: chatMode,
            isAutoContinue: true,
            todos: todosRef.current,
            temporary: temporaryChatsEnabledRef.current,
            sandboxPreference: sandboxPreferenceRef.current,
            agentPermissionMode: agentPermissionModeRef.current,
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
    setAutoContinueCount,
    setIsAutoResuming,
    sendMessageRef,
    todosRef,
    temporaryChatsEnabledRef,
    sandboxPreferenceRef,
    agentPermissionModeRef,
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
    lastProcessedIndexRef.current = 0;
    setAutoContinueCount(0);
  }, [setAutoContinueCount]);

  return { resetAutoContinueCount };
}
