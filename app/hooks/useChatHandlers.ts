import { RefObject } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useGlobalState } from "../contexts/GlobalState";
import type { ChatMessage } from "@/types";

interface UseChatHandlersProps {
  chatId: string;
  messages: ChatMessage[];
  shouldFetchMessages: boolean;
  setShouldFetchMessages: (value: boolean) => void;
  setHasActiveChat: (value: boolean) => void;
  resetSidebarAutoOpenRef: RefObject<(() => void) | null>;
  sendMessage: (message: { text: string }, options?: { body?: any }) => void;
  stop: () => void;
  regenerate: (options?: { body?: any }) => void;
}

export const useChatHandlers = ({
  chatId,
  messages,
  shouldFetchMessages,
  setShouldFetchMessages,
  setHasActiveChat,
  resetSidebarAutoOpenRef,
  sendMessage,
  stop,
  regenerate,
}: UseChatHandlersProps) => {
  const { input, mode, setChatTitle, clearInput, todos, setCurrentChatId } =
    useGlobalState();

  // Mutations for message operations
  const deleteLastAssistantMessage = useMutation(
    api.messages.deleteLastAssistantMessage,
  );
  const saveMessageFromClient = useMutation(api.messages.saveMessageFromClient);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      if (messages.length === 0) {
        setChatTitle(null);
        setCurrentChatId(chatId);
        // Update URL to use the actual chatId (whether provided or generated)
        window.history.replaceState({}, "", `/c/${chatId}`);
        // Enable message fetching after first submit for new chats
        if (!shouldFetchMessages) {
          setShouldFetchMessages(true);
        }
        // Ensure we render the chat layout immediately
        setHasActiveChat(true);
      }

      if (resetSidebarAutoOpenRef.current) {
        resetSidebarAutoOpenRef.current();
      }

      sendMessage(
        { text: input },
        {
          body: {
            mode,
            todos,
          },
        },
      );
      clearInput();
    }
  };

  const handleStop = async () => {
    // Save the current assistant message before stopping
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
    // Remove the last assistant message from the UI and database
    await deleteLastAssistantMessage({ chatId });

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
  };
};
