"use client";

import { useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { isCodexLocal } from "@/types/chat";
import { removeDraft } from "@/lib/utils/client-storage";
import type { ChatMessage } from "@/types";
import type { CodexLocalTransport } from "@/lib/local-providers/codex-transport";

interface UseCodexPersistenceProps {
  chatId: string;
  codexTransport: CodexLocalTransport;
  selectedModelRef: React.RefObject<string>;
  isExistingChatRef: React.RefObject<boolean>;
  setIsExistingChat: (value: boolean) => void;
}

/**
 * Handles persisting local provider (Codex) messages and thread state to Convex.
 * Called from onFinish when streaming completes for a local provider model.
 */
export function useCodexPersistence({
  chatId,
  codexTransport,
  selectedModelRef,
  isExistingChatRef,
  setIsExistingChat,
}: UseCodexPersistenceProps) {
  const saveLocalMessage = useMutation(api.messages.saveLocalMessage);
  const saveLocalChat = useMutation(api.chats.saveLocalChat);

  const persistCodexMessages = useCallback(
    async (messages: ChatMessage[]) => {
      if (!isCodexLocal(selectedModelRef.current)) return false;

      try {
        // Save all messages (user + assistant) to Convex
        await Promise.all(
          messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((msg) =>
              saveLocalMessage({
                id: msg.id,
                chatId,
                role: msg.role as "user" | "assistant",
                parts: msg.parts || [],
                model:
                  msg.role === "assistant"
                    ? selectedModelRef.current || "codex-local"
                    : undefined,
              }),
            ),
        );

        // Persist the Codex thread ID so it survives page reloads
        const threadId = codexTransport.getThreadId(chatId);
        if (threadId) {
          saveLocalChat({
            id: chatId,
            title: "", // won't overwrite — saveLocalChat patches existing
            codexThreadId: threadId,
          }).catch(() => {});
        }

        if (!isExistingChatRef.current) {
          window.history.replaceState({}, "", `/c/${chatId}`);
          removeDraft("new");
          setIsExistingChat(true);
        }
      } catch (error) {
        console.error("[CodexLocal] Failed to save messages:", error);
      }

      return true;
    },
    [
      chatId,
      codexTransport,
      selectedModelRef,
      isExistingChatRef,
      setIsExistingChat,
      saveLocalMessage,
      saveLocalChat,
    ],
  );

  return { persistCodexMessages };
}
