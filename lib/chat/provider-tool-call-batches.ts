import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";

export const MAX_ASSISTANT_TOOL_CALLS = 128;

/** Counts only: never put tool IDs, arguments, results, or user text in logs. */
export function getProviderToolCallDiagnostics(messages: ModelMessage[]) {
  let maxCalls = 0;
  let unmatchedResults = 0;
  let unmatchedCalls = 0;
  let duplicateCalls = 0;
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") {
      unmatchedCalls += pending.size;
      pending.clear();
    }
    if (!Array.isArray(message.content)) continue;
    let count = 0;
    for (const part of message.content) {
      if (part.type === "tool-call") {
        count++;
        if (pending.has(part.toolCallId)) duplicateCalls++;
        pending.add(part.toolCallId);
      } else if (part.type === "tool-result") {
        if (!pending.delete(part.toolCallId)) unmatchedResults++;
      }
    }
    maxCalls = Math.max(maxCalls, count);
  }
  return {
    max_tool_calls_per_assistant: maxCalls,
    unmatched_tool_call_count: unmatchedCalls + pending.size,
    unmatched_tool_result_count: unmatchedResults,
    duplicate_tool_call_count: duplicateCalls,
  };
}

/**
 * Old stored turns may have lost their step-start boundaries, collapsing a
 * long tool history into one assistant message. Split only complete batches;
 * never drop calls/results or guess how an ambiguous history should be paired.
 * This changes the provider transcript only and never executes a tool.
 */
export function splitProviderToolCallBatches(messages: ModelMessage[]) {
  const result: ModelMessage[] = [];
  let splitCount = 0;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      result.push(message);
      continue;
    }
    const calls = message.content.filter((part) => part.type === "tool-call");
    if (calls.length <= MAX_ASSISTANT_TOOL_CALLS) {
      result.push(message);
      continue;
    }
    const toolMessages: ToolModelMessage[] = [];
    for (let next = index + 1; messages[next]?.role === "tool"; next++) {
      toolMessages.push(messages[next] as ToolModelMessage);
    }
    const ids = new Set(calls.map((call) => call.toolCallId));
    const results = toolMessages.flatMap((tool) => tool.content);
    const resultIds = new Set(
      results.map((part) =>
        part.type === "tool-result" ? part.toolCallId : undefined,
      ),
    );
    if (
      ids.size !== calls.length ||
      results.length !== calls.length ||
      resultIds.size !== calls.length ||
      results.some(
        (part) => part.type !== "tool-result" || !ids.has(part.toolCallId),
      )
    ) {
      result.push(message);
      continue;
    }

    let content: Exclude<AssistantModelMessage["content"], string> = [];
    let batchIds = new Set<string>();
    const flush = () => {
      result.push({ ...message, content });
      for (const tool of toolMessages) {
        const batchResults = tool.content.filter(
          (part) =>
            part.type === "tool-result" && batchIds.has(part.toolCallId),
        );
        if (batchResults.length)
          result.push({ ...tool, content: batchResults });
      }
      content = [];
      batchIds = new Set();
    };
    for (const part of message.content) {
      if (part.type === "tool-call") {
        if (batchIds.size === MAX_ASSISTANT_TOOL_CALLS) flush();
        batchIds.add(part.toolCallId);
      }
      content.push(part);
    }
    flush();
    splitCount++;
    index += toolMessages.length;
  }
  return { messages: splitCount ? result : messages, splitCount };
}
