"use client";

import { useCallback, useRef } from "react";
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
  const persistedIdsRef = useRef(new Set<string>());

  const persistCodexMessages = useCallback(
    async (messages: ChatMessage[]) => {
      if (!isCodexLocal(selectedModelRef.current)) return false;

      try {
        // Only save new messages (skip already-persisted ones)
        const newMessages = messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .filter((m) => !persistedIdsRef.current.has(m.id));

        if (newMessages.length > 0) {
          await Promise.all(
            newMessages.map((msg) =>
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
          for (const msg of newMessages) {
            persistedIdsRef.current.add(msg.id);
          }
        }

        // Persist the Codex thread ID so it survives page reloads
        const threadId = codexTransport.getThreadId(chatId);
        if (threadId) {
          saveLocalChat({
            id: chatId,
            title: "", // won't overwrite — saveLocalChat patches existing
            codexThreadId: threadId,
          }).catch((err) => {
            console.error("[CodexLocal] Failed to persist codexThreadId:", err);
          });
        }

        if (!isExistingChatRef.current) {
          window.history.replaceState({}, "", `/c/${chatId}`);
          removeDraft("new");
          setIsExistingChat(true);
        }

        return true;
      } catch (error) {
        console.error("[CodexLocal] Failed to save messages:", error);
        return false;
      }
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
