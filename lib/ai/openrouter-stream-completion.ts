import { createParser } from "eventsource-parser";

/** Observe wire terminals before the provider adapter can synthesize a finish on EOF. */
export function createOpenRouterCompletionObserver() {
  const decoder = new TextDecoder();
  let terminalObserved = false;
  const parser = createParser({
    onEvent({ data }) {
      if (terminalObserved || data === "[DONE]") return;
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        // Leave malformed payload errors to the provider adapter; never log data.
        return;
      }
      if (!value || typeof value !== "object") return;
      if ("error" in value && value.error != null) {
        // Preserve the adapter's original provider error, including its status.
        terminalObserved = true;
        return;
      }
      if (!("choices" in value) || !Array.isArray(value.choices)) return;
      const reason = value.choices[0]?.finish_reason;
      terminalObserved = typeof reason === "string" && reason.trim().length > 0;
    },
  });
  return {
    feed(chunk: Uint8Array) {
      if (terminalObserved) return;
      parser.feed(decoder.decode(chunk, { stream: true }));
      if (terminalObserved) parser.reset();
    },
    finish() {
      // An unterminated SSE event is not a terminal event. Do not flush it.
      parser.reset();
      if (!terminalObserved) {
        throw new Error(
          "OpenRouter stream terminated before a completion finish reason.",
        );
      }
    },
    reset() {
      parser.reset();
    },
  };
}
