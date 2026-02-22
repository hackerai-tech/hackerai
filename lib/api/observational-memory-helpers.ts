/**
 * Observational Memory Helpers
 *
 * Step functions for integrating Mastra Observational Memory into the chat
 * and agent-task pipelines. Kept in a separate file from the legacy
 * summarization helpers so both systems can coexist cleanly.
 */

import { generateId, type UIMessage, type ModelMessage } from "ai";
import {
  runObservation,
  getObservationContext,
  getObservedMessageIds,
} from "@/lib/ai/observational-memory";
import { isSummaryMessage } from "@/lib/chat/summarization/helpers";
import {
  truncateMessagesToTokenLimit,
  MAX_TOKENS_PAID,
} from "@/lib/token-utils";
import { countTokens } from "gpt-tokenizer";

/** Reserve for system prompt so messages + observations + system fit in budget */
const SYSTEM_PROMPT_RESERVE = 12_000;

/**
 * Inject observation context into messages, removing already-observed messages.
 *
 * Two-stage filtering:
 *   1. Remove messages whose IDs are in `observedMessageIds` — the OM's
 *      observations replace those messages, so sending both is redundant.
 *   2. Apply a dynamic token budget as a safety net so the total
 *      (messages + observations + system prompt) fits within context.
 *
 * Messages are placed so that the stable prefix is maximized for KV-cache:
 *   [system prompt] + [historical messages] = CACHED
 *   [last user message with observations] + [new content] = reprocessed
 */
export function injectObservationsIntoMessages(
  messages: UIMessage[],
  observationContext: string | null,
  observedMessageIds?: Set<string>,
): UIMessage[] {
  if (!observationContext) {
    console.log(
      `[OM] injectObservations: no observation context, passing ${messages.length} messages through`,
    );
    return messages;
  }

  // Stage 1: Remove messages already captured by observations (by ID)
  let filtered = messages;
  if (observedMessageIds && observedMessageIds.size > 0) {
    filtered = messages.filter((msg) => !observedMessageIds.has(msg.id));
    const removed = messages.length - filtered.length;
    if (removed > 0) {
      console.log(
        `[OM] Filtered ${removed} observed messages from LLM context (${observedMessageIds.size} total observed)`,
      );
    }
  }

  // Stage 2: Dynamic token budget as safety net
  const observationTokens = countTokens(observationContext);
  const messageBudget = Math.max(
    0,
    MAX_TOKENS_PAID - observationTokens - SYSTEM_PROMPT_RESERVE,
  );
  const trimmed = truncateMessagesToTokenLimit(filtered, {}, messageBudget);

  console.log(
    `[OM] injectObservations: observationTokens=${observationTokens} messageBudget=${messageBudget} ` +
      `messages=${messages.length}→filtered=${filtered.length}→trimmed=${trimmed.length}`,
  );

  // Find the last user message
  let lastUserIdx = -1;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (trimmed[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx === -1) return trimmed;

  // Prepend observation context as a text part to the last user message
  const lastUserMsg = trimmed[lastUserIdx];
  const modifiedMsg: UIMessage = {
    ...lastUserMsg,
    parts: [
      { type: "text" as const, text: observationContext },
      ...lastUserMsg.parts,
    ],
  };

  const result = [...trimmed];
  result[lastUserIdx] = modifiedMsg;
  return result;
}

/**
 * Load existing observations AND observed message IDs from LibSQL for a chat thread.
 * Called at request start to inject prior observations into messages
 * before the first LLM step — avoids waiting for prepareStep.
 */
export async function loadExistingObservationContext(
  chatId: string,
  userId: string,
): Promise<{
  observationContext: string | null;
  observedMessageIds: Set<string>;
}> {
  try {
    const [context, ids] = await Promise.all([
      getObservationContext(chatId, userId),
      getObservedMessageIds(chatId, userId),
    ]);
    if (context) {
      console.log(
        `[OM] Loaded existing observations for chatId=${chatId} (${context.length} chars, ${ids.size} observed IDs)`,
      );
    }
    return { observationContext: context, observedMessageIds: ids };
  } catch (error) {
    console.error("[OM] Failed to load existing observations:", error);
    return { observationContext: null, observedMessageIds: new Set() };
  }
}

export interface ObservationalMemoryStepResult {
  hasObservations: boolean;
  observationContext: string | null;
  observedMessageIds: Set<string>;
}

export async function runObservationalMemoryStep(options: {
  messages: UIMessage[];
  chatId: string;
  userId: string;
}): Promise<ObservationalMemoryStepResult> {
  try {
    // Strip legacy summary messages before OM processing
    const hadLegacySummary =
      options.messages.length > 0 && isSummaryMessage(options.messages[0]);
    const messagesForOM = hadLegacySummary
      ? options.messages.slice(1)
      : options.messages;

    if (hadLegacySummary) {
      console.log("[OM] Stripped legacy <context_summary> message before OM");
    }

    console.log(
      `[OM] Step started chatId=${options.chatId} messages=${messagesForOM.length}`,
    );
    const stepStart = Date.now();

    await runObservation(options.chatId, options.userId, messagesForOM);

    // Fetch both observations and observed IDs after observe() persists the record
    const [context, ids] = await Promise.all([
      getObservationContext(options.chatId, options.userId),
      getObservedMessageIds(options.chatId, options.userId),
    ]);

    const elapsed = Date.now() - stepStart;
    console.log(
      `[OM] Step completed in ${elapsed}ms hasObservations=${context !== null}` +
        (context ? ` contextLength=${context.length}` : "") +
        ` observedIds=${ids.size}`,
    );

    return {
      hasObservations: context !== null,
      observationContext: context,
      observedMessageIds: ids,
    };
  } catch (error) {
    console.error("[OM] Failed to run observational memory:", error);
    return {
      hasObservations: false,
      observationContext: null,
      observedMessageIds: new Set(),
    };
  }
}

// ---------------------------------------------------------------------------
// Inject observations into ModelMessage[] (prepareStep's growing messages)
// ---------------------------------------------------------------------------

/**
 * Inject observation context into the AI SDK's `ModelMessage[]` from prepareStep.
 *
 * Unlike `injectObservationsIntoMessages` (which works on UIMessage[]), this
 * operates on the growing model messages so we preserve all tool calls and
 * results from previous steps. Prepends the observation text to the last user
 * message's content.
 */
export function injectObservationsIntoModelMessages(
  messages: ModelMessage[],
  observationContext: string | null,
): ModelMessage[] {
  if (!observationContext) return messages;

  // Find last user message
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return messages;

  const lastUser = messages[lastUserIdx];
  const content = (lastUser as any).content;
  const obsPart = { type: "text" as const, text: observationContext };

  let newContent: any;
  if (typeof content === "string") {
    newContent = [obsPart, { type: "text" as const, text: content }];
  } else if (Array.isArray(content)) {
    newContent = [obsPart, ...content];
  } else {
    newContent = [obsPart];
  }

  const result = [...messages];
  result[lastUserIdx] = { ...lastUser, content: newContent } as ModelMessage;
  return result;
}

// ---------------------------------------------------------------------------
// ModelMessage → UIMessage conversion for prepareStep messages
// ---------------------------------------------------------------------------

/**
 * Convert the AI SDK's `ModelMessage[]` (from prepareStep) to `UIMessage[]`
 * so the OM can observe the growing conversation during multi-step streaming.
 *
 * Tool results from `role: 'tool'` messages are merged back into the preceding
 * assistant message's tool-invocation parts (matching by toolCallId).
 */
export function modelMessagesToUIMessages(
  modelMessages: ModelMessage[],
): UIMessage[] {
  const result: UIMessage[] = [];

  for (const msg of modelMessages) {
    if (msg.role === "system") continue; // OM doesn't need system messages

    if (msg.role === "user") {
      const content = msg.content;
      const parts: any[] = [];
      if (typeof content === "string") {
        parts.push({ type: "text", text: content });
      } else if (Array.isArray(content)) {
        for (const p of content) {
          if ((p as any).type === "text") {
            parts.push({ type: "text", text: (p as any).text });
          }
          // Skip image/file parts — OM only needs text + tool interactions
        }
      }
      if (parts.length > 0) {
        result.push({
          id: generateId(),
          role: "user",
          parts,
        } as UIMessage);
      }
    } else if (msg.role === "assistant") {
      const content = msg.content;
      const parts: any[] = [];
      if (typeof content === "string") {
        if (content) parts.push({ type: "text", text: content });
      } else if (Array.isArray(content)) {
        for (const p of content) {
          const pt = p as any;
          if (pt.type === "text") {
            parts.push({ type: "text", text: pt.text });
          } else if (pt.type === "reasoning") {
            parts.push({ type: "reasoning", reasoning: pt.text });
          } else if (pt.type === "tool-call") {
            // Initially state='call', will be upgraded to 'result' when
            // we encounter the matching tool message below
            parts.push({
              type: "tool-invocation",
              toolInvocation: {
                state: "call",
                toolCallId: pt.toolCallId,
                toolName: pt.toolName,
                args: pt.input ?? {},
              },
            });
          }
        }
      }
      if (parts.length > 0) {
        result.push({
          id: generateId(),
          role: "assistant",
          parts,
        } as UIMessage);
      }
    } else if (msg.role === "tool") {
      // Merge tool results into the preceding assistant message's tool-invocation parts
      const content = Array.isArray(msg.content) ? msg.content : [];
      const prevAssistant =
        result.length > 0 && result[result.length - 1].role === "assistant"
          ? result[result.length - 1]
          : null;

      for (const tp of content) {
        const tpr = tp as any;
        if (tpr.type !== "tool-result") continue;
        if (!prevAssistant) continue;

        // Find matching tool-invocation part and upgrade to 'result'
        const match = prevAssistant.parts.find(
          (p: any) =>
            p.type === "tool-invocation" &&
            p.toolInvocation?.toolCallId === tpr.toolCallId,
        ) as any;
        if (match) {
          match.toolInvocation.state = "result";
          match.toolInvocation.result = tpr.output;
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Async (fire-and-forget) observation for continuous OM
// ---------------------------------------------------------------------------

/** Track in-flight async observations per chat to avoid concurrent runs. */
const _observationInFlight = new Map<string, Promise<void>>();

/**
 * Fire-and-forget observation with callback. Returns immediately.
 *
 * The OM's internal `messageTokens` threshold decides whether the Observer
 * LLM actually runs — most calls just count tokens and return fast.
 *
 * When observation completes and produces new observations, the `onComplete`
 * callback is invoked with the results. The caller stores these in local
 * state and picks them up on the next `prepareStep` — no DB polling needed.
 *
 * Only one observation runs per chat at a time; concurrent calls are no-ops.
 */
export function runObservationalMemoryStepAsync(options: {
  messages?: UIMessage[];
  modelMessages?: ModelMessage[];
  chatId: string;
  userId: string;
  onComplete?: (result: ObservationalMemoryStepResult) => void;
}): void {
  const key = options.chatId;
  if (_observationInFlight.has(key)) {
    console.log(
      `[OM-async] Skipped — observation already in-flight for chatId=${key}`,
    );
    return;
  }

  const promise = (async () => {
    try {
      // Resolve UIMessages: prefer modelMessages (growing conversation from prepareStep)
      // over static messages (initial request messages)
      const rawMessages = options.modelMessages
        ? modelMessagesToUIMessages(options.modelMessages)
        : (options.messages ?? []);

      // Strip legacy summary messages
      const hadLegacySummary =
        rawMessages.length > 0 && isSummaryMessage(rawMessages[0]);
      const messagesForOM = hadLegacySummary
        ? rawMessages.slice(1)
        : rawMessages;

      console.log(
        `[OM-async] Observation started chatId=${options.chatId} messages=${messagesForOM.length}` +
          (options.modelMessages ? " (from modelMessages)" : ""),
      );
      const start = Date.now();

      await runObservation(options.chatId, options.userId, messagesForOM);

      // Read results after observe() persists the record
      const [context, ids] = await Promise.all([
        getObservationContext(options.chatId, options.userId),
        getObservedMessageIds(options.chatId, options.userId),
      ]);

      const elapsed = Date.now() - start;
      console.log(
        `[OM-async] Observation completed in ${elapsed}ms chatId=${options.chatId}` +
          (context
            ? ` contextLength=${context.length} observedIds=${ids.size}`
            : " (no observations)"),
      );

      if (context && options.onComplete) {
        console.log(
          `[OM-async] Calling onComplete callback chatId=${options.chatId} contextLength=${context.length} observedIds=${ids.size}`,
        );
        options.onComplete({
          hasObservations: true,
          observationContext: context,
          observedMessageIds: ids,
        });
      } else if (!context) {
        console.log(
          `[OM-async] No observations produced (threshold not reached) chatId=${options.chatId}`,
        );
      }
    } catch (error) {
      console.error("[OM-async] Observation failed:", error);
    }
  })();

  _observationInFlight.set(key, promise);
  promise.finally(() => _observationInFlight.delete(key));
}
