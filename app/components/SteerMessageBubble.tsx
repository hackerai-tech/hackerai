import { Forward } from "lucide-react";

/**
 * A follow-up sent into a running Agent, shown like the user's own message
 * with a small "Steer" label above it. While the Agent has not read it yet,
 * the label says so and the bubble is dimmed.
 */
export function SteerMessageBubble({
  text,
  pending = false,
}: {
  text: string;
  pending?: boolean;
}) {
  return (
    <div
      className="my-2 flex w-full flex-col items-end gap-1"
      data-testid={pending ? "pending-agent-steer" : "agent-steer-message"}
    >
      <div
        className="flex items-center gap-1 pe-1 text-sm text-muted-foreground"
        role={pending ? "status" : undefined}
      >
        <Forward aria-hidden="true" className="size-3.5" />
        <span>{pending ? "Steer · waiting to be read" : "Steer"}</span>
      </div>
      <div
        className={`max-w-[80%] rounded-[18px] rounded-se-lg border border-border bg-secondary px-4 py-1.5 text-primary-foreground ${
          pending ? "opacity-70" : ""
        }`}
      >
        <div className="whitespace-pre-wrap break-words">{text}</div>
      </div>
    </div>
  );
}
