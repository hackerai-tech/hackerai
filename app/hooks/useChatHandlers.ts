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
    api.messages.deleteLastAssistantMessage,
  );
  const saveAssistantMessage = useMutation(api.messages.saveAssistantMessage);
  const regenerateWithNewContent = useMutation(
    api.messages.regenerateWithNewContent,
  );
  const cancelStreamMutation = useMutation(api.chats.cancelStreamFromClient);
  const cancelTempStreamMutation = useMutation(
    api.tempStreams.cancelTempStreamFromClient,
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

    // Stop the stream immediately (client-side abort)
    stop();

    if (!temporaryChatsEnabled) {
      // Cancel the stream in database first (sets canceled_at for backend detection)
      cancelStreamMutation({ chatId }).catch((error) => {
        console.error("Failed to cancel stream:", error);
      });

      // Save the current message state immediately to prevent extra tokens from appearing
      const lastMessage = messages[messages.length - 1];
      if (lastMessage && lastMessage.role === "assistant") {
        saveAssistantMessage({
          id: lastMessage.id,
          chatId,
          role: lastMessage.role,
          parts: lastMessage.parts,
        }).catch((error) => {
          console.error("Failed to save message on stop:", error);
        });
      }
    } else {
      // Temporary chats: signal cancel via temp stream coordination
      cancelTempStreamMutation({ chatId }).catch(() => {});
    }
  };

  const handleRegenerate = async () => {
    setIsAutoResuming(false);

    // Remove only todos from the last assistant message being regenerated.
    // This ensures that if the new run yields no todos, old assistant todos won't persist,
    // while preserving todos from previous assistant messages.
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    const lastAssistantId = lastAssistant?.id;
    const cleanedTodos = lastAssistantId
      ? removeTodosBySourceMessages(todos, [lastAssistantId])
      : todos;
    if (cleanedTodos !== todos) setTodos(cleanedTodos);

    if (!temporaryChatsEnabled) {
      // Delete last assistant message and update todos in a single transaction
      await deleteLastAssistantMessage({ chatId, todos: cleanedTodos });
      // For persisted chats, backend fetches from database - explicitly send no messages
      regenerate({
        body: {
          mode: chatMode,
          messages: [],
          todos: cleanedTodos,
          regenerate: true,
          temporary: false,
        },
      });
    } else {
      // For temporary chats, send all messages except the last assistant message
      const messagesForRegenerate =
        messages && messages.length > 0 ? messages.slice(0, -1) : messages;
      regenerate({
        body: {
          mode: chatMode,
          messages: messagesForRegenerate,
          todos: cleanedTodos,
          regenerate: true,
          temporary: true,
        },
      });
    }
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
    if (!temporaryChatsEnabled) {
      // For persisted chats, backend fetches from database - explicitly send no messages
      regenerate({
        body: {
          mode: chatMode,
          messages: [],
          todos: cleanedTodos,
          regenerate: true,
          temporary: false,
        },
      });
    } else {
      // For temporary chats, send all messages
      regenerate({
        body: {
          mode: chatMode,
          messages,
          todos: cleanedTodos,
          regenerate: true,
          temporary: true,
        },
      });
    }
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
      try {
        await regenerateWithNewContent({
          messageId: messageId as Id<"messages">,
          newContent,
        });
      } catch (error) {
        // Swallow benign errors (e.g., racing edits where the message was already removed)
        // Avoid logging to keep console clean
      }
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

    // For persisted chats, backend fetches from database
    // For temporary chats, send all messages up to and including the edited message
    if (!temporaryChatsEnabled) {
      regenerate({
        body: {
          mode: chatMode,
          messages: [],
          todos: cleanedTodosForEdit,
          regenerate: true,
          temporary: false,
        },
      });
    } else {
      // For temporary chats, send messages up to and including the edited message
      const messagesUpToEdit = messages.slice(0, editedMessageIndex + 1);
      const editedMessage = messages[editedMessageIndex];
      messagesUpToEdit[editedMessageIndex] = {
        ...editedMessage,
        parts: [{ type: "text", text: newContent }],
      };

      regenerate({
        body: {
          mode: chatMode,
          messages: messagesUpToEdit,
          todos: cleanedTodosForEdit,
          regenerate: true,
          temporary: true,
        },
      });
    }
  };

  return {
    handleSubmit,
    handleStop,
    handleRegenerate,
    handleRetry,
    handleEditMessage,
  };
};
