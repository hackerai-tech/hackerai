import { RefObject, useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useGlobalState } from "../contexts/GlobalState";
import type { ChatMessage, ChatStatus } from "@/types";
import { Id } from "@/convex/_generated/dataModel";
import {
  countInputTokens,
  getMaxTokensForSubscription,
  MAX_TOKENS_FILE,
} from "@/lib/token-utils";
import { toast } from "sonner";
import { removeTodosBySourceMessages } from "@/lib/utils/todo-utils";
import { useDataStream } from "@/app/components/DataStreamProvider";
import { normalizeMessages } from "@/lib/utils/message-processor";

interface UseChatHandlersProps {
  chatId: string;
  messages: ChatMessage[];
  sendMessage: (message?: any, options?: { body?: any }) => void;
  stop: () => void;
  regenerate: (options?: { body?: any }) => void;
  setMessages: (
    messages: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
  ) => void;
  isExistingChat: boolean;
  activateChatLocally: () => void;
  status: ChatStatus;
  isSendingNowRef: RefObject<boolean>;
  hasManuallyStoppedRef: RefObject<boolean>;
  onStopCallback?: () => void;
}

export const useChatHandlers = ({
  chatId,
  messages,
  sendMessage,
  stop,
  regenerate,
  setMessages,
  isExistingChat,
  activateChatLocally,
  status,
  isSendingNowRef,
  hasManuallyStoppedRef,
  onStopCallback,
}: UseChatHandlersProps) => {
  const { setIsAutoResuming } = useDataStream();
  const {
    input,
    uploadedFiles,
    chatMode,
    clearInput,
    clearUploadedFiles,
    todos,
    setTodos,
    isUploadingFiles,
    subscription,
    temporaryChatsEnabled,
    queueMessage,
    messageQueue,
    removeQueuedMessage,
    queueBehavior,
    sandboxPreference,
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
  const cancelStreamMutation = useMutation(api.chatStreams.cancelStreamFromClient);
  const cancelTempStreamMutation = useMutation(
    api.tempStreams.cancelTempStreamFromClient,
  );

  /**
   * Helper to stop an active stream, normalize messages, and persist state.
   * Returns the normalized messages array.
   * Should be called before any message management operation during streaming.
   */
  const stopActiveStream = async (options?: {
    skipSave?: boolean;
  }): Promise<ChatMessage[]> => {
    // Stop the stream immediately (client-side abort)
    stop();

    // Early return if no messages to process
    if (messages.length === 0) return messages;

    // Normalize messages to mark incomplete tools as interrupted/completed
    const { messages: normalizedMessages, hasChanges } =
      normalizeMessages(messages);

    // Update local state if changes were made
    if (hasChanges) {
      setMessages(normalizedMessages);
    }

    if (!temporaryChatsEnabledRef.current) {
      // Run cancel and save in parallel - they're independent operations
      const lastMessage = normalizedMessages[normalizedMessages.length - 1];
      const savePromise =
        !options?.skipSave && lastMessage?.role === "assistant"
          ? saveAssistantMessage({
              id: lastMessage.id,
              chatId,
              role: lastMessage.role,
              parts: lastMessage.parts,
            }).catch((error) => {
              console.error("Failed to save message on stop:", error);
            })
          : Promise.resolve();

      await Promise.all([
        cancelStreamMutation({
          chatId,
          skipSave: options?.skipSave || undefined,
        }).catch((error) => {
          console.error("Failed to cancel stream:", error);
        }),
        savePromise,
      ]);
    } else {
      // Temporary chats: signal cancel via temp stream coordination
      await cancelTempStreamMutation({ chatId }).catch(() => {});
    }

    return normalizedMessages;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsAutoResuming(false);

    // Reset manual stop flag when user submits a new message
    hasManuallyStoppedRef.current = false;

    // Prevent submission if files are still uploading
    if (isUploadingFiles) {
      return;
    }
    // Allow submission if there's text input or uploaded files
    const hasValidFiles = uploadedFiles.some((f) => f.uploaded && f.url);
    if (input.trim() || hasValidFiles) {
      // If streaming in Agent mode, check queue behavior
      if (status === "streaming" && chatMode === "agent") {
        const validFiles = uploadedFiles.filter(
          (file) => file.uploaded && file.url && file.fileId,
        );

        if (queueBehavior === "queue") {
          // Queue the message - will auto-send after current response completes
          queueMessage(
            input,
            validFiles.map((f) => ({
              file: f.file,
              fileId: f.fileId! as Id<"files">,
              url: f.url!,
            })),
          );
          clearInput();
          clearUploadedFiles();
          return;
        } else if (queueBehavior === "stop-and-send") {
          // Immediately stop current stream and send right away
          stop();

          // Cancel the stream in database and save current message state
          if (!temporaryChatsEnabledRef.current) {
            cancelStreamMutation({ chatId }).catch((error) => {
              console.error("Failed to cancel stream:", error);
            });

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
          // Continue to send the new message immediately below (don't return)
        }
      }
      // Check token limit before sending based on user plan
      const tokenCount = countInputTokens(input, uploadedFiles);
      const maxTokens = getMaxTokensForSubscription(subscription);

      // Additional validation for Ask mode: ensure files don't exceed Ask mode token limits
      // This prevents uploading files in Agent mode then switching to Ask mode to send them
      if (chatMode === "ask" && uploadedFiles.length > 0) {
        const fileTokens = uploadedFiles.reduce(
          (total, file) => total + (file.tokens || 0),
          0,
        );
        if (fileTokens > MAX_TOKENS_FILE) {
          toast.error("Cannot send files in Ask mode", {
            description: `Files exceed Ask mode token limit (${fileTokens.toLocaleString()}/${MAX_TOKENS_FILE.toLocaleString()} tokens). Tip: Switch to Agent mode or remove large files.`,
          });
          return;
        }
      }

      if (tokenCount > maxTokens) {
        const hasFiles = uploadedFiles.length > 0;
        const planText = subscription !== "free" ? "" : " (Free plan limit)";
        toast.error("Message is too long", {
          description: `Your message is too large (${tokenCount.toLocaleString()} tokens). Please make it shorter${hasFiles ? " or remove some files" : ""}${planText}.`,
        });
        return;
      }
      if (!isExistingChat && !temporaryChatsEnabledRef.current) {
        window.history.replaceState({}, "", `/c/${chatId}`);
        activateChatLocally();
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
              sandboxPreference,
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
              sandboxPreference,
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

    // Set manual stop flag to prevent auto-processing of queue
    hasManuallyStoppedRef.current = true;

    // Clear any active status indicators immediately
    onStopCallback?.();

    try {
      await stopActiveStream();
    } catch (error) {
      console.error("Error in handleStop:", error);
    }
  };

  const handleRegenerate = async () => {
    setIsAutoResuming(false);

    // Stop any active stream first to prevent message order issues and wasted tokens
    if (status === "streaming") {
      await stopActiveStream({ skipSave: true });
    }

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
      // Always delete the last assistant message when regenerating
      // This prevents accumulation of empty messages when user aborts quickly multiple times
      // The deleteLastAssistantMessage mutation queries DB for the last assistant message,
      // so it will only delete if one exists
      if (lastAssistant) {
        await deleteLastAssistantMessage({
          chatId,
          todos: cleanedTodos,
        });
      }
      // For persisted chats, backend fetches from database - explicitly send no messages
      regenerate({
        body: {
          mode: chatMode,
          messages: [],
          todos: cleanedTodos,
          regenerate: true,
          temporary: false,
          sandboxPreference,
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
          sandboxPreference,
        },
      });
    }
  };

  const handleRetry = async () => {
    setIsAutoResuming(false);

    // Stop any active stream first to prevent message order issues and wasted tokens
    if (status === "streaming") {
      await stopActiveStream({ skipSave: true });
    }

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
          sandboxPreference,
        },
      });
    } else {
      // For temporary chats, filter out empty assistant message if present (from error)
      // Check if last message is an empty assistant message
      const lastMessage = messages[messages.length - 1];
      const isLastMessageEmptyAssistant =
        lastMessage?.role === "assistant" &&
        (!lastMessage.parts || lastMessage.parts.length === 0);

      const messagesToSend = isLastMessageEmptyAssistant
        ? messages.slice(0, -1)
        : messages;

      regenerate({
        body: {
          mode: chatMode,
          messages: messagesToSend,
          todos: cleanedTodos,
          regenerate: true,
          temporary: true,
          sandboxPreference,
        },
      });
    }
  };

  const handleEditMessage = async (
    messageId: string,
    newContent: string,
    remainingFileIds?: string[],
  ) => {
    setIsAutoResuming(false);

    // Stop any active stream first to prevent message order issues and wasted tokens
    if (status === "streaming") {
      await stopActiveStream({ skipSave: true });
    }

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
          fileIds: remainingFileIds,
        });
      } catch (error) {
        // Swallow benign errors (e.g., racing edits where the message was already removed)
        // Avoid logging to keep console clean
      }
    }

    // Build updated parts: text + remaining file parts
    const buildUpdatedParts = (currentParts: any[]) => {
      const newParts: any[] = [];

      // Add text part if there's content
      if (newContent.trim()) {
        newParts.push({ type: "text", text: newContent });
      }

      // Keep file parts that are in remainingFileIds
      if (remainingFileIds && remainingFileIds.length > 0) {
        const remainingFileParts = currentParts.filter(
          (part) =>
            part.type === "file" &&
            part.fileId &&
            remainingFileIds.includes(part.fileId),
        );
        newParts.push(...remainingFileParts);
      }

      return newParts;
    };

    // Update local state to reflect the edit and remove subsequent messages
    setMessages((prevMessages) => {
      const editedMessageIndex = prevMessages.findIndex(
        (msg) => msg.id === messageId,
      );

      if (editedMessageIndex === -1) return prevMessages;

      const updatedMessages = prevMessages.slice(0, editedMessageIndex + 1);
      const currentMessage = updatedMessages[editedMessageIndex];
      updatedMessages[editedMessageIndex] = {
        ...currentMessage,
        parts: buildUpdatedParts(currentMessage.parts),
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
          sandboxPreference,
        },
      });
    } else {
      // For temporary chats, send messages up to and including the edited message
      const messagesUpToEdit = messages.slice(0, editedMessageIndex + 1);
      const editedMessage = messages[editedMessageIndex];

      // Build updated parts for the edited message
      const updatedParts: any[] = [];
      if (newContent.trim()) {
        updatedParts.push({ type: "text", text: newContent });
      }
      if (remainingFileIds && remainingFileIds.length > 0) {
        const remainingFileParts = editedMessage.parts.filter(
          (part: any) =>
            part.type === "file" &&
            part.fileId &&
            remainingFileIds.includes(part.fileId),
        );
        updatedParts.push(...remainingFileParts);
      }

      messagesUpToEdit[editedMessageIndex] = {
        ...editedMessage,
        parts: updatedParts,
      };

      regenerate({
        body: {
          mode: chatMode,
          messages: messagesUpToEdit,
          todos: cleanedTodosForEdit,
          regenerate: true,
          temporary: true,
          sandboxPreference,
        },
      });
    }
  };

  const handleSendNow = async (messageId: string) => {
    const message = messageQueue.find((m) => m.id === messageId);
    if (!message) return;

    // Set flag to prevent auto-processing from interfering
    isSendingNowRef.current = true;

    // Reset manual stop flag when using Send Now
    hasManuallyStoppedRef.current = false;

    try {
      // Remove the message from queue FIRST (before stopping)
      removeQueuedMessage(messageId);

      // Stop the stream using the shared helper
      setIsAutoResuming(false);
      await stopActiveStream();

      // Send the queued message immediately
      const validFiles = message.files || [];
      const messagePayload: any = {};

      // Only add text if it exists
      if (message.text) {
        messagePayload.text = message.text;
      }

      // Only add files if they exist
      if (validFiles.length > 0) {
        messagePayload.files = validFiles.map((f) => ({
          type: "file" as const,
          filename: f.file.name,
          mediaType: f.file.type,
          url: f.url,
          fileId: f.fileId,
        }));
      }

      sendMessage(messagePayload, {
        body: {
          mode: chatMode,
          todos,
          temporary: temporaryChatsEnabled,
          sandboxPreference,
        },
      });
    } catch (error) {
      console.error("Failed to send queued message:", error);
    } finally {
      // Clear flag after a brief delay to allow status to change
      setTimeout(() => {
        isSendingNowRef.current = false;
      }, 200);
    }
  };

  return {
    handleSubmit,
    handleStop,
    handleRegenerate,
    handleRetry,
    handleEditMessage,
    handleSendNow,
  };
};
