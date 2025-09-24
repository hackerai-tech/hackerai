import { RefObject, useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useGlobalState } from "../contexts/GlobalState";
import type { ChatMessage } from "@/types";
import { Id } from "@/convex/_generated/dataModel";
import {
  countInputTokens,
  getMaxTokensForSubscription,
} from "@/lib/token-utils";
import { toast } from "sonner";
import { removeTodosBySourceMessages } from "@/lib/utils/todo-utils";
import { useDataStream } from "@/app/components/DataStreamProvider";

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
  isExistingChat: boolean;
  activateChatLocally: () => void;
}

export const useChatHandlers = ({
  chatId,
  messages,
  resetSidebarAutoOpenRef,
  sendMessage,
  stop,
  regenerate,
  setMessages,
  isExistingChat,
  activateChatLocally,
}: UseChatHandlersProps) => {
  const { setIsAutoResuming } = useDataStream();
  const {
    input,
    uploadedFiles,
    chatMode,
    setChatTitle,
    clearInput,
    clearUploadedFiles,
    todos,
    setTodos,
    setCurrentChatId,
    isUploadingFiles,
    subscription,
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
    setIsAutoResuming(false);
    // Prevent submission if files are still uploading
    if (isUploadingFiles) {
      return;
    }
    // Allow submission if there's text input or uploaded files
    const hasValidFiles = uploadedFiles.some((f) => f.uploaded && f.url);
    if (input.trim() || hasValidFiles) {
      // Check token limit before sending based on user plan
      const tokenCount = countInputTokens(input, uploadedFiles);
      const maxTokens = getMaxTokensForSubscription(subscription);
      if (tokenCount > maxTokens) {
        const hasFiles = uploadedFiles.length > 0;
        const planText = subscription !== "free" ? "" : " (Free plan limit)";
        toast.error("Message is too long", {
          description: `Your message is too large (${tokenCount.toLocaleString()} tokens). Please make it shorter${hasFiles ? " or remove some files" : ""}${planText}.`,
        });
        return;
      }
      if (!isExistingChat && !temporaryChatsEnabledRef.current) {
        setChatTitle(null);
        setCurrentChatId(chatId);
        window.history.replaceState({}, "", `/c/${chatId}`);
        activateChatLocally();
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
              mode: chatMode,
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
              mode: chatMode,
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
    setIsAutoResuming(false);
    stop();

    const lastMessage = messages[messages.length - 1];
    if (
      !temporaryChatsEnabled &&
      lastMessage &&
      lastMessage.role === "assistant"
    ) {
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
    setIsAutoResuming(false);

    // Always remove all assistant-sourced todos before regeneration.
    // This ensures that if the new run yields no todos, old assistant todos won't persist.
    const cleanedTodos = removeTodosBySourceMessages(
      todos,
      todos
        .filter((t) => t.sourceMessageId)
        .map((t) => t.sourceMessageId as string),
    );
    if (cleanedTodos !== todos) setTodos(cleanedTodos);

    if (!temporaryChatsEnabled) {
      await deleteLastAssistantMessage({ chatId });
    }

    regenerate({
      body: {
        mode: chatMode,
        // Send cleaned todos and current messages so server can filter assistant todos reliably
        messages,
        todos: cleanedTodos,
        regenerate: true,
        temporary: temporaryChatsEnabled,
      },
    });
  };

  const handleRetry = async () => {
    setIsAutoResuming(false);
    const cleanedTodos = removeTodosBySourceMessages(
      todos,
      todos
        .filter((t) => t.sourceMessageId)
        .map((t) => t.sourceMessageId as string),
    );
    if (cleanedTodos !== todos) setTodos(cleanedTodos);

    regenerate({
      body: {
        mode: chatMode,
        messages,
        todos: cleanedTodos,
        regenerate: true,
        temporary: temporaryChatsEnabled,
      },
    });
  };

  const handleEditMessage = async (messageId: string, newContent: string) => {
    setIsAutoResuming(false);
    // Find the edited message index to identify subsequent messages
    const editedMessageIndex = messages.findIndex((m) => m.id === messageId);

    if (editedMessageIndex !== -1) {
      // Get all subsequent messages (both user and assistant) that will be removed
      const subsequentMessages = messages.slice(editedMessageIndex + 1);
      const idsToClean = subsequentMessages.map((m) => m.id);

      // Also clean todos from the edited message itself if it's an assistant message
      const editedMessage = messages[editedMessageIndex];
      if (editedMessage.role === "assistant") {
        idsToClean.push(messageId);
      }

      // Remove todos linked to the edited message and all subsequent messages
      if (idsToClean.length > 0) {
        const updatedTodos = removeTodosBySourceMessages(todos, idsToClean);
        setTodos(updatedTodos);
      }
    }

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

    // Trigger regeneration of assistant response with cleaned todos
    const cleanedTodosForEdit = (() => {
      const editedIndex = messages.findIndex((m) => m.id === messageId);
      if (editedIndex === -1) return todos;
      const subsequentMessages = messages.slice(editedIndex + 1);
      const idsToClean = subsequentMessages.map((m) => m.id);
      const editedMessage = messages[editedIndex];
      if (editedMessage.role === "assistant") idsToClean.push(messageId);
      return removeTodosBySourceMessages(todos, idsToClean);
    })();

    regenerate({
      body: {
        mode: chatMode,
        todos: cleanedTodosForEdit,
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
