import type { ToolFailureLogEvent, ToolFailureLogger } from "@/types";

export const reportToolFailure = (
  onToolFailure: ToolFailureLogger | undefined,
  event: ToolFailureLogEvent,
) => {
  try {
    void Promise.resolve(onToolFailure?.(event)).catch(() => {
      // Tool failure observability must not change the tool result.
    });
  } catch {
    // Tool failure observability must not change the tool result.
  }
};
