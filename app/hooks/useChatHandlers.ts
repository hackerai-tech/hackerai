import { RefObject } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useGlobalState } from "../contexts/GlobalState";
import type { ChatMessage } from "@/types";
import { Id } from "@/convex/_generated/dataModel";
import { createFileUIObject, type FileUIObject } from "@/lib/utils/file-utils";

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
  } = useGlobalState();

  const deleteLastAssistantMessage = useMutation(
    api.messages.deleteLastAssistantMessage,
  );
  const saveMessageFromClient = useMutation(api.messages.saveMessageFromClient);
  const regenerateWithNewContent = useMutation(
    api.messages.regenerateWithNewContent,
  );
  const generateUploadUrl = useMutation(api.messages.generateUploadUrl);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Allow submission if there's text input or uploaded files
    const hasValidFiles = uploadedFiles.some(f => f.uploaded && f.url);
    if (input.trim() || hasValidFiles) {
      if (!hasActiveChat) {
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
        const fileObjects: FileUIObject[] = uploadedFiles
          .filter(file => file.uploaded && file.url)
          .map(uploadedFile => createFileUIObject(uploadedFile.file, uploadedFile.url!));

        sendMessage(
          {
            text: input.trim() || undefined,
            files: fileObjects.length > 0 ? fileObjects : undefined,
          },
          {
            body: {
              mode,
              todos,
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
    if (lastMessage && lastMessage.role === "assistant") {
      try {
        await saveMessageFromClient({
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
    await deleteLastAssistantMessage({ chatId });

    regenerate({
      body: {
        mode,
        todos,
        regenerate: true,
      },
    });
  };

  const handleEditMessage = async (messageId: string, newContent: string) => {
    await regenerateWithNewContent({
      messageId: messageId as Id<"messages">,
      newContent,
    });

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
      },
    });
  };

  return {
    handleSubmit,
    handleStop,
    handleRegenerate,
    handleEditMessage,
  };
};
