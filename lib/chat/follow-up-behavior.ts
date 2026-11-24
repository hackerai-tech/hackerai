import type { QueueBehavior } from "@/types/chat";

/** ⌘/Ctrl+Enter sends the other way: queue instead of steer, and vice versa. */
export const isAlternateSubmit = (event: unknown) => {
  if (!event || typeof event !== "object") return false;
  const { metaKey, ctrlKey } = event as {
    metaKey?: unknown;
    ctrlKey?: unknown;
  };
  return metaKey === true || ctrlKey === true;
};

export function resolveFollowUpBehavior(
  preferred: QueueBehavior,
  alternate: boolean,
): QueueBehavior {
  if (!alternate) return preferred;
  return preferred === "steer" ? "queue" : "steer";
}
