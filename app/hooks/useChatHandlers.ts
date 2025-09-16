import { RefObject, useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useGlobalState } from "../contexts/GlobalState";
import type { ChatMessage } from "@/types";
import { Id } from "@/convex/_generated/dataModel";
import {
  countInputTokens,
  MAX_TOKENS_PRO,
  MAX_TOKENS_FREE,
} from "@/lib/token-utils";
import { toast } from "sonner";

interface UseChatHandlersProps {
  chatId: string;
  messages: ChatMessage[];
  resetSidebarAutoOpenRef: RefObject<(() => void) | null>;
  sendMessage: (message?: any, options?: { body?: any }) => void;
  stop: () => void;
  regenerate: (options?: { body?: any }) => void;
  setMessages: (
    messages: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
  ) => void;
}

export const useChatHandlers = ({
  chatId,
  messages,
  resetSidebarAutoOpenRef,
  sendMessage,
  stop,
  regenerate,
  setMessages,
}: UseChatHandlersProps) => {
  const {
    input,
    uploadedFiles,
    mode,
    setChatTitle,
    clearInput,
    clearUploadedFiles,
    todos,
    setCurrentChatId,
    shouldFetchMessages,
    setShouldFetchMessages,
    hasActiveChat,
    setHasActiveChat,
    isUploadingFiles,
    hasProPlan,
    temporaryChatsEnabled,
  } = useGlobalState();

  // Avoid stale closure on temporary flag
  const temporaryChatsEnabledRef = useRef(temporaryChatsEnabled);
  useEffect(() => {
    temporaryChatsEnabledRef.current = temporaryChatsEnabled;
  }, [temporaryChatsEnabled]);

  const deleteLastAssistantMessage = useMutation(
    api.messages.deleteLastAssistantMessageFromClient,
  );
  const saveAssistantMessage = useMutation(
    api.messages.saveAssistantMessageFromClient,
  );
  const regenerateWithNewContent = useMutation(
    api.messages.regenerateWithNewContentFromClient,
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Prevent submission if files are still uploading
    if (isUploadingFiles) {
      return;
    }
    // Allow submission if there's text input or uploaded files
    const hasValidFiles = uploadedFiles.some((f) => f.uploaded && f.url);
    if (input.trim() || hasValidFiles) {
      // Check token limit before sending based on user plan
      const tokenCount = countInputTokens(input, uploadedFiles);
      const maxTokens = hasProPlan ? MAX_TOKENS_PRO : MAX_TOKENS_FREE;
      if (tokenCount > maxTokens) {
        const hasFiles = uploadedFiles.length > 0;
        const planText = hasProPlan ? "" : " (Free plan limit)";
        toast.error("Message is too long", {
          description: `Your message is too large (${tokenCount.toLocaleString()} tokens). Please make it shorter${hasFiles ? " or remove some files" : ""}${planText}.`,
        });
        return;
      }
      if (!hasActiveChat && !temporaryChatsEnabledRef.current) {
        setChatTitle(null);
        setCurrentChatId(chatId);
        window.history.replaceState({}, "", `/c/${chatId}`);
        if (!shouldFetchMessages) {
          setShouldFetchMessages(true);
        }
        setHasActiveChat(true);
      }

      if (resetSidebarAutoOpenRef.current) {
        resetSidebarAutoOpenRef.current();
      }

      try {
        // Get file objects from uploaded files - URLs are already resolved in global state
        const validFiles = uploadedFiles.filter(
          (file) => file.uploaded && file.url && file.fileId,
        );

        sendMessage(
          {
            text: input.trim() || undefined,
            files:
              validFiles.length > 0
                ? validFiles.map((uploadedFile) => ({
                    type: "file" as const,
                    filename: uploadedFile.file.name,
                    mediaType: uploadedFile.file.type,
                    url: uploadedFile.url!,
                    fileId: uploadedFile.fileId!,
                  }))
                : undefined,
          },
          {
            body: {
              mode,
              todos,
              temporary: temporaryChatsEnabled,
            },
          },
        );
      } catch (error) {
        console.error("Failed to process files:", error);
        // Fallback to text-only message if file processing fails
        sendMessage(
          { text: input },
          {
            body: {
              mode,
              todos,
              temporary: temporaryChatsEnabled,
            },
          },
        );
      }

      clearInput();
      clearUploadedFiles();
    }
  };

  const handleStop = async () => {
    stop();

    const lastMessage = messages[messages.length - 1];
    if (!temporaryChatsEnabled && lastMessage && lastMessage.role === "assistant") {
      try {
        await saveAssistantMessage({
          id: lastMessage.id,
          chatId,
          role: lastMessage.role,
          parts: lastMessage.parts,
        });
      } catch (error) {
        console.error("Failed to save message on stop:", error);
      }
    }
  };

  const handleRegenerate = async () => {
    if (!temporaryChatsEnabled) {
      await deleteLastAssistantMessage({ chatId });
    }

    regenerate({
      body: {
        mode,
        todos,
        regenerate: true,
        temporary: temporaryChatsEnabled,
      },
    });
  };

  const handleRetry = async () => {
    regenerate({
      body: {
        mode,
        todos,
        regenerate: true,
        temporary: temporaryChatsEnabled,
      },
    });
  };

  const handleEditMessage = async (messageId: string, newContent: string) => {
    if (!temporaryChatsEnabled) {
      await regenerateWithNewContent({
        messageId: messageId as Id<"messages">,
        newContent,
      });
    }

    // Update local state to reflect the edit and remove subsequent messages
    setMessages((prevMessages) => {
      const editedMessageIndex = prevMessages.findIndex(
        (msg) => msg.id === messageId,
      );

      if (editedMessageIndex === -1) return prevMessages;

      const updatedMessages = prevMessages.slice(0, editedMessageIndex + 1);
      updatedMessages[editedMessageIndex] = {
        ...updatedMessages[editedMessageIndex],
        parts: [{ type: "text", text: newContent }],
      };

      return updatedMessages;
    });

    // Trigger regeneration of assistant response
    regenerate({
      body: {
        mode,
        todos,
        regenerate: true,
        temporary: temporaryChatsEnabled,
      },
    });
  };

  return {
    handleSubmit,
    handleStop,
    handleRegenerate,
    handleRetry,
    handleEditMessage,
  };
};
