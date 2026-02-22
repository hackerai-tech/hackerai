import "server-only";

import {
  ObservationalMemory,
  OBSERVATION_CONTEXT_PROMPT,
  OBSERVATION_CONTEXT_INSTRUCTIONS,
  OBSERVATION_CONTINUATION_HINT,
} from "@mastra/memory/processors";
import { LibSQLStore } from "@mastra/libsql";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { MemoryStorage } from "@mastra/core/storage";
import type { UIMessage } from "ai";
import { OBSERVATIONAL_MEMORY_MODEL } from "./providers";
import { MAX_TOKENS_PAID, OBSERVATION_MESSAGE_BUDGET } from "../token-utils";
import { countTokens } from "gpt-tokenizer";

// ---------------------------------------------------------------------------
// Storage + OM singletons (lazy async init – creates tables on first use)
// ---------------------------------------------------------------------------

let _initPromise: Promise<{
  storage: LibSQLStore;
  om: ObservationalMemory;
}> | null = null;

function getInitPromise() {
  if (!_initPromise) {
    _initPromise = (async () => {
      const url = process.env.MASTRA_MEMORY_DB_URL || "file:./mastra-memory.db";
      const authToken = process.env.MASTRA_MEMORY_DB_AUTH_TOKEN;

      const storage = new LibSQLStore({
        id: "hackerai-om",
        url,
        ...(authToken ? { authToken } : {}),
      });

      // Create tables (mastra_observational_memory, etc.) if they don't exist
      await storage.init();
      console.log("[OM] LibSQLStore initialized (tables ready)");

      const om = new ObservationalMemory({
        storage: storage.stores.memory as MemoryStorage,
        model: OBSERVATIONAL_MEMORY_MODEL,
        scope: "thread",
        observation: {
          messageTokens: OBSERVATION_MESSAGE_BUDGET,
          bufferTokens: false,
          instruction:
            "This is a security/pentesting agent. Adapt your observation style accordingly.\n\n" +
            "MANDATORY RULES (override any default guidelines):\n" +
            "1. TOOL CALLS: For EVERY [Tool Call] and [Tool Result], observe the exact tool name and key arguments.\n" +
            "2. FILE PATHS: When ANY file is read, written, created, or saved, you MUST record the full file path.\n" +
            "   - Write/save: '-> wrote report to /workspace/reports/recon-report.md'\n" +
            "   - Read: '-> read /etc/nginx/nginx.conf:45-60, found proxy_pass to internal API'\n" +
            "   - Tool output saved: '-> subfinder output saved to /tmp/subdomains.txt'\n" +
            "3. COMMANDS: Record the exact command with key flags. '-> nmap -sV -p- 10.0.0.1' not 'ran nmap'\n" +
            "4. OUTPUT LOCATIONS: If a tool writes output to a file, or the agent saves/creates any file, " +
            "the path MUST appear in the observation. This is critical for the agent to find its own work later.\n\n" +
            "Prioritize: target scope/IPs, vulnerabilities with exact URLs/paths/payloads, " +
            "credentials found, failed approaches, current task. " +
            "Compress verbose outputs into key findings but NEVER drop file paths, URLs, IPs, ports, or payloads.",
        },
        reflection: {
          observationTokens: MAX_TOKENS_PAID - OBSERVATION_MESSAGE_BUDGET,
          instruction:
            "When consolidating, group related findings by target/service. " +
            "Preserve exact technical details (URLs, IPs, ports, payloads). " +
            "Mark failed approaches clearly to avoid repetition.\n" +
            "MANDATORY: NEVER drop file paths or output locations — the agent relies on these to find saved reports, " +
            "tool outputs, and artifacts. If an observation says a file was written/saved, the path MUST survive reflection.\n" +
            "NEVER drop tool names or exact commands — the agent needs to know what was already tried and with what flags.",
        },
      });

      return { storage, om };
    })();
  }
  return _initPromise;
}

async function getOM(): Promise<ObservationalMemory> {
  const { om } = await getInitPromise();
  return om;
}

// ---------------------------------------------------------------------------
// Message format conversion: UIMessage <-> MastraDBMessage
// ---------------------------------------------------------------------------

/**
 * Convert custom `tool-{name}` parts to `tool-invocation` parts that
 * the Mastra OM's `formatMessagesForObserver` can process.
 *
 * The project uses custom part types like `tool-run_terminal_cmd` with
 * `{ state: "output-available", input, output }`, but the OM only
 * recognises `{ type: "tool-invocation", toolInvocation: { state, toolName, args, result } }`.
 * Without this conversion the Observer would only see text parts and
 * miss all tool interactions — critical for a pentesting agent.
 */
function convertPartsForOM(
  parts: UIMessage["parts"],
): MastraDBMessage["content"]["parts"] {
  return parts.map((part) => {
    const p = part as Record<string, unknown>;

    // Already a standard tool-invocation — pass through
    if (p.type === "tool-invocation") {
      return part as MastraDBMessage["content"]["parts"][number];
    }

    // Custom tool-{name} part → convert to tool-invocation
    if (
      typeof p.type === "string" &&
      p.type.startsWith("tool-") &&
      p.toolCallId
    ) {
      const toolName = (p.type as string).slice("tool-".length);

      // Map custom states to tool-invocation states
      let state: "partial-call" | "call" | "result";
      if (p.state === "output-available" || p.state === "output-error") {
        state = "result";
      } else if (p.state === "input-available") {
        state = "call";
      } else {
        state = "partial-call";
      }

      return {
        type: "tool-invocation" as const,
        toolInvocation: {
          state,
          toolCallId: p.toolCallId as string,
          toolName,
          args: p.input ?? {},
          ...(state === "result" ? { result: p.output ?? p.result ?? {} } : {}),
        },
      } as MastraDBMessage["content"]["parts"][number];
    }

    // Everything else (text, reasoning, file, data-*, etc.) — pass through
    return part as MastraDBMessage["content"]["parts"][number];
  });
}

/**
 * Convert an AI SDK UIMessage to a MastraDBMessage.
 *
 * Custom `tool-{name}` parts are converted to standard `tool-invocation`
 * parts so the OM Observer can see tool calls and results.
 *
 * Preserves the original `createdAt` timestamp so the OM's
 * `lastObservedAt` cursor-based tracking works correctly across requests.
 */
export function uiMessageToMastraMessage(
  msg: UIMessage,
  threadId: string,
  resourceId?: string,
): MastraDBMessage {
  return {
    id: msg.id,
    role: msg.role as "user" | "assistant" | "system",
    createdAt: (msg as any).createdAt
      ? new Date((msg as any).createdAt)
      : new Date(),
    threadId,
    resourceId,
    content: {
      format: 2 as const,
      parts: convertPartsForOM(msg.parts),
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the OM observation cycle for a chat thread.
 *
 * Converts UIMessages to MastraDBMessages and passes them directly to
 * `observe()` (in-memory, no duplication into LibSQL message tables).
 * The Observer runs if unobserved message tokens exceed the threshold.
 *
 * This is the replacement for `checkAndSummarizeIfNeeded()`.
 */
export async function runObservation(
  chatId: string,
  userId: string,
  messages: UIMessage[],
): Promise<void> {
  const om = await getOM();
  const mastraMessages = messages.map((m) =>
    uiMessageToMastraMessage(m, chatId, userId),
  );

  // Estimate total message tokens to compare against threshold
  const estimatedTokens = mastraMessages.reduce((sum, m) => {
    const parts = m.content?.parts;
    if (!Array.isArray(parts)) return sum;
    for (const p of parts) {
      if ((p as { type: string }).type === "text") {
        sum += countTokens((p as { text: string }).text || "");
      } else if ((p as { type: string }).type === "tool-invocation") {
        const inv = (
          p as { toolInvocation?: { args?: unknown; result?: unknown } }
        ).toolInvocation;
        if (inv?.args) sum += countTokens(JSON.stringify(inv.args));
        if (inv?.result) sum += countTokens(JSON.stringify(inv.result));
      }
    }
    return sum;
  }, 0);

  console.log(
    `[OM] runObservation chatId=${chatId} messageCount=${messages.length} ` +
      `estimatedTokens=${estimatedTokens} threshold=${OBSERVATION_MESSAGE_BUDGET} ` +
      `willObserve=${estimatedTokens >= OBSERVATION_MESSAGE_BUDGET}`,
  );
  const start = Date.now();

  await om.observe({
    threadId: chatId,
    resourceId: userId,
    messages: mastraMessages,
  });

  console.log(`[OM] observe() completed in ${Date.now() - start}ms`);
}

/**
 * Get the formatted observation context to inject into the system prompt.
 * Returns null if no observations exist yet for this thread.
 */
export async function getObservationContext(
  chatId: string,
  userId: string,
): Promise<string | null> {
  const om = await getOM();
  const observations = await om.getObservations(chatId, userId);

  if (!observations) {
    console.log(
      `[OM] getObservationContext chatId=${chatId} → no observations`,
    );
    return null;
  }

  const contextLength = observations.length;
  console.log(
    `[OM] getObservationContext chatId=${chatId} → ${contextLength} chars of observations`,
  );

  return [
    OBSERVATION_CONTEXT_PROMPT,
    "",
    "<observations>",
    observations,
    "</observations>",
    "",
    OBSERVATION_CONTEXT_INSTRUCTIONS,
    "",
    OBSERVATION_CONTINUATION_HINT,
  ].join("\n");
}

/**
 * Check whether OM has active observations for this thread.
 * Used for the stop condition (replacing `hasSummarized`).
 */
export async function hasActiveObservations(
  chatId: string,
  userId: string,
): Promise<boolean> {
  const om = await getOM();
  const record = await om.getRecord(chatId, userId);
  return !!record?.activeObservations;
}

/**
 * Get the set of message IDs that the OM has already observed.
 * Used to filter observed messages from the LLM context — the OM's
 * observations replace those messages, so sending both is redundant.
 */
export async function getObservedMessageIds(
  chatId: string,
  userId: string,
): Promise<Set<string>> {
  const om = await getOM();
  const record = await om.getRecord(chatId, userId);
  const ids = (record as any)?.observedMessageIds;
  return new Set(Array.isArray(ids) ? ids : []);
}
