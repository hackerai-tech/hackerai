import { useState, useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import type { ChatMessage } from "@/types";

interface UseFeedbackProps {
  messages: ChatMessage[];
  setMessages: (messages: ChatMessage[]) => void;
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
      if (type === "positive") {
        // For positive feedback, save immediately
        try {
          await createFeedback({
            feedback_type: "positive",
            message_id: messageId,
          });

          // Update local message state immediately
          setMessages(
            messages.map((msg) =>
              msg.id === messageId
                ? { ...msg, metadata: { feedbackType: "positive" } }
                : msg,
            ),
          );

          toast.success("Thank you for your feedback!");
        } catch (error) {
          console.error("Failed to save feedback:", error);
          toast.error("Failed to save feedback. Please try again.");
        }
      } else {
        // For negative feedback, save immediately without details and show input
        try {
          await createFeedback({
            feedback_type: "negative",
            message_id: messageId,
          });

          // Update local message state immediately
          setMessages(
            messages.map((msg) =>
              msg.id === messageId
                ? { ...msg, metadata: { feedbackType: "negative" } }
                : msg,
            ),
          );

          // Then show input for additional details
          setFeedbackInputMessageId(messageId);
        } catch (error) {
          console.error("Failed to save initial negative feedback:", error);
          toast.error("Failed to save feedback. Please try again.");
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
        toast.error("Failed to save feedback details. Please try again.");
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
