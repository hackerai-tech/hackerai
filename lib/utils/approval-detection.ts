import { UIMessage } from "ai";

/**
 * Detects if a request is an approval continuation
 * (tool approval or rate limit approval)
 *
 * Works with both:
 * - Full message array (old behavior)
 * - Single approved message (optimized behavior)
 */
export const isApprovalContinuation = (messages: UIMessage[]): boolean => {
  if (!messages || messages.length === 0) return false;

  return messages.some((msg) =>
    msg.parts?.some((part) => {
      const state = (part as any).state;

      // Check for any approval response states
      // Only approval-requiring parts (tools, rate limits) have these states
      return state === "approval-responded" || state === "output-denied";
    }),
  );
};
