import { useCallback, useLayoutEffect, useRef } from "react";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatMessage, QueuedMessage } from "@/types/chat";
import { useCommittedRef } from "./useLatestRef";
import { AGENT_RESUME_ENDPOINT } from "@/lib/api/agent-endpoints";
import { getPendingAgentLongRunStart } from "@/lib/chat/agent-long-transport";
import { toast } from "sonner";

// Explicit retries stay well inside the Agent route's six-hour dedupe TTL.
const QUEUED_SEND_RETRY_WINDOW_MS = 5 * 60 * 60 * 1000;

type Attempt = {
  chatId: string;
  id: string;
  accepted: boolean;
  onAccepted?: () => void;
};
type Props = {
  chatId: string;
  messages: ChatMessage[];
  queue: QueuedMessage[];
  enabled: boolean;
  isStopped?: () => boolean;
  getRequestGeneration?: () => number;
  sendDisabledReason?: string;
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  resumeStream: UseChatHelpers<ChatMessage>["resumeStream"];
  remove: (id: string) => void;
  setDelivery: (
    id: string,
    status: NonNullable<QueuedMessage["deliveryStatus"]>,
    firstAttemptAt: number,
  ) => void;
};

export function useQueuedMessageDelivery(props: Props) {
  const current = useCommittedRef(props);
  const active = useRef<Attempt | null>(null);
  useLayoutEffect(
    () => () => {
      active.current = null;
    },
    [props.chatId],
  );

  const accept = useCallback(
    (chatId: string, messageId: string) => {
      const attempt = active.current;
      if (
        !attempt ||
        attempt.chatId !== chatId ||
        attempt.id !== messageId ||
        current.current.chatId !== chatId
      )
        return;
      attempt.accepted = true;
      attempt.onAccepted?.();
      active.current = null;
      current.current.remove(messageId);
    },
    [current],
  );

  const send = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      const initial = current.current;
      const message = initial.queue.find((item) => item.id === id);
      if (
        !message ||
        active.current ||
        message.deliveryStatus === "sending" ||
        initial.sendDisabledReason ||
        !initial.enabled
      )
        return;
      const requestGeneration = initial.getRequestGeneration?.();
      const attempt: Attempt = { chatId: initial.chatId, id, accepted: false };
      active.current = attempt;
      const firstAttemptAt = message.firstAttemptAt ?? Date.now();
      const isCurrent = () =>
        active.current === attempt &&
        current.current.chatId === attempt.chatId &&
        current.current.queue.some((item) => item.id === id);
      let heldStatus: "failed" | "active" = "failed";
      initial.setDelivery(id, "sending", firstAttemptAt);
      try {
        if (message.deliveryStatus) {
          // A lost POST response does not prove the durable run failed to start.
          // Reconnect first; a retry retains the original user-message ID so the
          // route's existing idempotency key also covers a late admission race.
          await getPendingAgentLongRunStart(attempt.chatId);
          if (!isCurrent()) return;
          const response = await fetch(
            `${AGENT_RESUME_ENDPOINT}?chatId=${encodeURIComponent(attempt.chatId)}`,
            { cache: "no-store" },
          );
          if (
            !isCurrent() ||
            current.current.isStopped?.() ||
            current.current.getRequestGeneration?.() !== requestGeneration ||
            current.current.sendDisabledReason ||
            !current.current.enabled
          )
            return;
          if (response.status === 200) {
            // A run handle alone does not identify the queued turn. Keep it
            // held without claiming this specific message was admitted.
            heldStatus = "active";
            await current.current.resumeStream();
            return;
          }
          if (response.status !== 204)
            throw new Error("Could not check the Agent run. Try again.");
          const elapsed = Date.now() - firstAttemptAt;
          if (elapsed < 0 || elapsed >= QUEUED_SEND_RETRY_WINDOW_MS) {
            throw new Error(
              "Reload this chat and review its saved progress before sending this message again.",
            );
          }
        }
        if (
          !isCurrent() ||
          current.current.sendDisabledReason ||
          !current.current.enabled ||
          current.current.isStopped?.() ||
          current.current.getRequestGeneration?.() !== requestGeneration
        )
          return;
        const messages = current.current.messages;
        const existingIndex = messages.findIndex((item) => item.id === id);
        if (
          existingIndex >= 0 &&
          messages.slice(existingIndex + 1).some((item) => item.role === "user")
        ) {
          throw new Error(
            "A newer message was sent. Review the chat before sending this message again.",
          );
        }
        const admitted = new Promise<void>((resolve) => {
          attempt.onAccepted = resolve;
        });
        const sending = current.current.sendMessage(
          {
            id,
            role: "user",
            parts: [
              ...(message.files ?? []),
              ...(message.text
                ? [{ type: "text" as const, text: message.text }]
                : []),
            ] as ChatMessage["parts"],
            metadata: { createdAt: message.timestamp },
            ...(existingIndex >= 0 ? { messageId: id } : {}),
          },
          { body },
        );
        await Promise.race([sending, admitted]);
        // The SDK can resolve after onError or abort. Only the transport's
        // admission callback retires this intent; promise resolution does not.
      } catch (error) {
        if (isCurrent())
          toast.error(
            error instanceof Error
              ? error.message
              : "Could not send the queued message. Try again.",
          );
      } finally {
        if (isCurrent() && !attempt.accepted)
          current.current.setDelivery(id, heldStatus, firstAttemptAt);
        if (active.current === attempt) active.current = null;
      }
    },
    [current],
  );

  return { send, accept };
}
