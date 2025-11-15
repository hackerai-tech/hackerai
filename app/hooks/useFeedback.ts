import { useState, useCallback, Dispatch, SetStateAction } from "react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import type { ChatMessage } from "@/types";

interface UseFeedbackProps {
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}

export const useFeedback = ({ messages, setMessages }: UseFeedbackProps) => {
  // Track feedback input state for negative feedback
  const [feedbackInputMessageId, setFeedbackInputMessageId] = useState<
    string | null
  >(null);

  // Convex mutation for feedback
  const createFeedback = useMutation(api.feedback.createFeedback);

  // Handle feedback submission (positive/negative)
  const handleFeedback = useCallback(
    async (messageId: string, type: "positive" | "negative") => {
      // Find the current message to check existing feedback
      const currentMessage = messages.find((msg) => msg.id === messageId);
      const existingFeedback = currentMessage?.metadata?.feedbackType;

      if (type === "positive") {
        // Skip if positive feedback already exists
        if (existingFeedback === "positive") {
          return;
        }

        // For positive feedback, save immediately
        try {
          await createFeedback({
            feedback_type: "positive",
            message_id: messageId,
          });

          // Update local message state and merge metadata
          setMessages(
            messages.map((msg) =>
              msg.id === messageId
                ? {
                    ...msg,
                    metadata: { ...msg.metadata, feedbackType: "positive" },
                  }
                : msg,
            ),
          );

          toast.success("Thank you for your feedback!");
        } catch (error) {
          console.error("Failed to save feedback:", error);
          const errorMessage =
            error instanceof ConvexError
              ? (error.data as { message?: string })?.message ||
                error.message ||
                "Failed to save feedback"
              : error instanceof Error
                ? error.message
                : "Failed to save feedback. Please try again.";
          toast.error(errorMessage);
        }
      } else {
        // For negative feedback
        if (existingFeedback === "negative") {
          // If negative feedback already exists, just show input for details
          setFeedbackInputMessageId(messageId);
          return;
        }

        // Save negative feedback immediately without details and show input
        try {
          await createFeedback({
            feedback_type: "negative",
            message_id: messageId,
          });

          // Update local message state and merge metadata
          setMessages(
            messages.map((msg) =>
              msg.id === messageId
                ? {
                    ...msg,
                    metadata: { ...msg.metadata, feedbackType: "negative" },
                  }
                : msg,
            ),
          );

          // Then show input for additional details
          setFeedbackInputMessageId(messageId);
        } catch (error) {
          console.error("Failed to save initial negative feedback:", error);
          const errorMessage =
            error instanceof ConvexError
              ? (error.data as { message?: string })?.message ||
                error.message ||
                "Failed to save feedback"
              : error instanceof Error
                ? error.message
                : "Failed to save feedback. Please try again.";
          toast.error(errorMessage);
        }
      }
    },
    [createFeedback, messages, setMessages],
  );

  // Handle negative feedback details submission (updates existing feedback)
  const handleFeedbackSubmit = useCallback(
    async (details: string) => {
      if (!feedbackInputMessageId) return;

      try {
        // Update the existing negative feedback with details
        await createFeedback({
          feedback_type: "negative",
          feedback_details: details,
          message_id: feedbackInputMessageId,
        });

        // Local state already shows negative feedback, just hide the input
        setFeedbackInputMessageId(null);
        toast.success("Thank you for your feedback!");
      } catch (error) {
        console.error("Failed to update feedback details:", error);
        const errorMessage =
          error instanceof ConvexError
            ? (error.data as { message?: string })?.message ||
              error.message ||
              "Failed to save feedback details"
            : error instanceof Error
              ? error.message
              : "Failed to save feedback details. Please try again.";
        toast.error(errorMessage);
      }
    },
    [createFeedback, feedbackInputMessageId],
  );

  // Handle feedback input cancellation
  const handleFeedbackCancel = useCallback(() => {
    setFeedbackInputMessageId(null);
  }, []);

  return {
    feedbackInputMessageId,
    handleFeedback,
    handleFeedbackSubmit,
    handleFeedbackCancel,
  };
};
