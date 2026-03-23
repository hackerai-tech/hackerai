import type { UIMessage } from "ai";
import { countTokens } from "gpt-tokenizer";

/**
 * Default rolling token budget for tool outputs (protection window).
 * Tool outputs newer than this budget are kept intact; older ones are
 * replaced with compact one-line placeholders. 40 000 tokens ≈ ~30K words,
 * enough to keep the most recent tool interactions fully detailed.
 */
export const TOOL_OUTPUT_TOKEN_BUDGET = 40_000;

/**
 * Minimum token savings required to justify pruning.
 * If pruning would save fewer tokens than this, skip it entirely —
 * the overhead of replacing outputs isn't worth the small savings.
 * Matches OpenCode's PRUNE_MINIMUM threshold.
 */
const PRUNE_MINIMUM_SAVINGS = 20_000;

/**
 * Tools whose outputs should never be pruned. These contain state
 * or instructions that the agent needs to reference throughout the
 * conversation regardless of age.
 */
const PROTECTED_TOOLS = new Set([
  "todo_write",
  "create_note",
  "list_notes",
  "update_note",
  "delete_note",
]);

const TOOL_TYPE_PREFIX = "tool-";

export interface PruneResult {
  messages: UIMessage[];
  prunedCount: number;
  tokensSaved: number;
  /** Total tokens across all eligible (non-protected, non-pruned) tool outputs */
  totalToolOutputTokens: number;
  /** Number of tool output parts evaluated */
  toolOutputCount: number;
  /** Why pruning was skipped (null if pruning occurred) */
  skipReason:
    | "no-tool-outputs"
    | "within-budget"
    | "below-minimum-savings"
    | null;
}

// ---------------------------------------------------------------------------
// Placeholder builders per tool type
// ---------------------------------------------------------------------------

interface ToolPart {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: any;
  output?: any;
}

/**
 * Builds a compact placeholder string given the tool name, its input args, and output.
 * Shared by both UIMessage and CoreMessage pruners.
 */
const buildPlaceholderFromParts = (
  toolName: string,
  input: any,
  output: any,
): string => {
  switch (toolName) {
    case "run_terminal_cmd": {
      const cmd = input?.command ?? "unknown";
      const shortCmd = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
      const exitCode = output?.exitCode ?? output?.exit_code ?? "?";
      return `[Terminal: ran '${shortCmd}', exit code ${exitCode}]`;
    }

    case "file": {
      const action = input?.action ?? "unknown";
      const path = input?.path ?? input?.file_path ?? "unknown";
      if (action === "read") {
        const content = output?.content ?? output ?? "";
        const lines =
          typeof content === "string" ? content.split("\n").length : "?";
        return `[File: read ${path} (${lines} lines)]`;
      }
      return `[File: ${action} ${path}]`;
    }

    case "match": {
      let count = "?";
      let files = "";
      if (Array.isArray(output)) {
        count = String(output.length);
        const fileSet = new Set(
          output
            .map((m: any) => m.file ?? m.path ?? m.filename)
            .filter(Boolean),
        );
        files =
          fileSet.size > 0 ? ` in ${[...fileSet].slice(0, 5).join(", ")}` : "";
        if (fileSet.size > 5) files += ` (+${fileSet.size - 5} more)`;
      } else if (output && typeof output === "object") {
        const results = output.results ?? output.matches ?? [];
        count = Array.isArray(results) ? String(results.length) : "?";
      }
      return `[Match: ${count} results${files}]`;
    }

    case "web_search":
    case "web": {
      const query = input?.query ?? "unknown";
      return `[Search: '${query}']`;
    }

    case "get_terminal_files": {
      const n = Array.isArray(output) ? output.length : "?";
      return `[Files: retrieved ${n} files]`;
    }

    case "open_url": {
      const url = input?.url ?? "unknown";
      return `[URL: opened ${url}]`;
    }

    default:
      return `[Tool: ${toolName} completed]`;
  }
};

/** Builds a placeholder from a UIMessage ToolPart */
const buildPlaceholder = (part: ToolPart): string => {
  const toolName = part.type.slice(TOOL_TYPE_PREFIX.length);
  return buildPlaceholderFromParts(toolName, part.input, part.output);
};

// ---------------------------------------------------------------------------
// Token counting for a tool output
// ---------------------------------------------------------------------------

const countOutputTokens = (output: unknown): number => {
  if (output == null) return 0;
  if (typeof output === "string") return countTokens(output);
  return countTokens(JSON.stringify(output));
};

// ---------------------------------------------------------------------------
// Main pruning function
// ---------------------------------------------------------------------------

/**
 * Prunes old tool outputs to stay within a rolling token budget.
 *
 * Walks messages from newest to oldest. For each tool part with
 * `state === "output-available"`, the output tokens are counted against
 * the remaining budget. Once the budget is exhausted, older tool outputs
 * are replaced with compact one-line placeholders.
 *
 * Returns a shallow copy of the messages array with pruned parts.
 * The original messages are not mutated.
 */
export function pruneToolOutputs(
  messages: UIMessage[],
  budget: number = TOOL_OUTPUT_TOKEN_BUDGET,
  minimumSavings: number = PRUNE_MINIMUM_SAVINGS,
): PruneResult {
  let remainingBudget = budget;
  let prunedCount = 0;
  let tokensSaved = 0;

  // Collect all tool parts newest→oldest with their locations
  const toolEntries: Array<{
    msgIdx: number;
    partIdx: number;
    part: ToolPart;
    tokens: number;
  }> = [];

  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi];
    // Walk parts in reverse so newest tool calls within a message come first
    for (let pi = msg.parts.length - 1; pi >= 0; pi--) {
      const part = msg.parts[pi] as ToolPart;
      const toolName = part.type?.startsWith(TOOL_TYPE_PREFIX)
        ? part.type.slice(TOOL_TYPE_PREFIX.length)
        : null;
      if (
        toolName &&
        !PROTECTED_TOOLS.has(toolName) &&
        (part.state === "output-available" || part.state === "output-error") &&
        part.output != null &&
        typeof part.output !== "string" // skip already-pruned placeholders
      ) {
        toolEntries.push({
          msgIdx: mi,
          partIdx: pi,
          part,
          tokens: countOutputTokens(part.output),
        });
      }
    }
  }

  // Nothing to prune
  if (toolEntries.length === 0) {
    return {
      messages,
      prunedCount: 0,
      tokensSaved: 0,
      totalToolOutputTokens: 0,
      toolOutputCount: 0,
      skipReason: "no-tool-outputs",
    };
  }

  const totalToolOutputTokens = toolEntries.reduce((s, e) => s + e.tokens, 0);

  // Determine which entries to prune (beyond budget)
  const toPrune = new Set<string>(); // "msgIdx:partIdx"

  for (const entry of toolEntries) {
    // Budget already exhausted by previous entries — prune this one
    if (remainingBudget <= 0) {
      toPrune.add(`${entry.msgIdx}:${entry.partIdx}`);
      prunedCount++;
      const placeholderTokens = countTokens(buildPlaceholder(entry.part));
      tokensSaved += entry.tokens - placeholderTokens;
      continue;
    }
    // Deduct from budget; if this entry causes overshoot, keep it but
    // subsequent entries will be pruned
    remainingBudget -= entry.tokens;
  }

  if (prunedCount === 0 || tokensSaved < minimumSavings) {
    return {
      messages,
      prunedCount: 0,
      tokensSaved: 0,
      totalToolOutputTokens,
      toolOutputCount: toolEntries.length,
      skipReason: prunedCount === 0 ? "within-budget" : "below-minimum-savings",
    };
  }

  // Build new messages array with pruned parts
  const newMessages: UIMessage[] = messages.map((msg, mi) => {
    // Check if any parts in this message need pruning
    const hasPartsToPrune = msg.parts.some((_, pi) =>
      toPrune.has(`${mi}:${pi}`),
    );
    if (!hasPartsToPrune) return msg;

    const newParts = msg.parts.map((part, pi) => {
      if (!toPrune.has(`${mi}:${pi}`)) return part;

      const toolPart = part as ToolPart;
      const placeholder = buildPlaceholder(toolPart);

      return {
        ...toolPart,
        output: placeholder,
      } as typeof part;
    });

    return { ...msg, parts: newParts } as typeof msg;
  });

  return {
    messages: newMessages,
    prunedCount,
    tokensSaved,
    totalToolOutputTokens,
    toolOutputCount: toolEntries.length,
    skipReason: null,
  };
}

// ---------------------------------------------------------------------------
// Model-level (CoreMessage) pruning — runs during the agentic loop
// ---------------------------------------------------------------------------

/**
 * A tool-result content part inside a CoreMessage with role "tool".
 * Shape: { type: "tool-result", toolCallId, toolName, output, providerOptions? }
 */
interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: unknown;
  providerOptions?: unknown;
}

export interface ModelPruneResult {
  messages: Array<Record<string, unknown>>;
  prunedCount: number;
  tokensSaved: number;
  totalToolOutputTokens: number;
  toolOutputCount: number;
  skipReason:
    | "no-tool-outputs"
    | "within-budget"
    | "below-minimum-savings"
    | null;
}

/**
 * Prunes old tool-result outputs in CoreMessage[] (model-level messages).
 *
 * This runs inside prepareStep to prune tool outputs that accumulate
 * during the agentic loop (up to 100 tool calls per streamText invocation).
 *
 * CoreMessage format:
 *   assistant: { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, args }] }
 *   tool:      { role: "tool", content: [{ type: "tool-result", toolCallId, toolName, output }] }
 *
 * To build rich placeholders, we first index tool-call args by toolCallId
 * from assistant messages, then correlate with tool-result outputs.
 */
export function pruneModelMessages(
  messages: Array<Record<string, unknown>>,
  budget: number = TOOL_OUTPUT_TOKEN_BUDGET,
  minimumSavings: number = PRUNE_MINIMUM_SAVINGS,
): ModelPruneResult {
  // Step 1: Index tool-call args by toolCallId for placeholder building
  const argsById = new Map<string, unknown>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as Record<string, unknown>;
      if (p.type === "tool-call" && typeof p.toolCallId === "string") {
        argsById.set(p.toolCallId, p.args);
      }
    }
  }

  // Step 2: Collect tool-result entries newest→oldest
  let remainingBudget = budget;
  const toolEntries: Array<{
    msgIdx: number;
    partIdx: number;
    toolName: string;
    toolCallId: string;
    output: unknown;
    tokens: number;
  }> = [];

  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi];
    if (msg.role !== "tool") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (let pi = (content as unknown[]).length - 1; pi >= 0; pi--) {
      const part = (content as unknown[])[pi] as ToolResultPart;
      if (
        part.type !== "tool-result" ||
        !part.toolName ||
        PROTECTED_TOOLS.has(part.toolName)
      )
        continue;

      // Skip already-pruned (string output = placeholder)
      if (typeof part.output === "string") continue;
      if (part.output == null) continue;

      const tokens = countOutputTokens(part.output);
      toolEntries.push({
        msgIdx: mi,
        partIdx: pi,
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        output: part.output,
        tokens,
      });
    }
  }

  if (toolEntries.length === 0) {
    return {
      messages,
      prunedCount: 0,
      tokensSaved: 0,
      totalToolOutputTokens: 0,
      toolOutputCount: 0,
      skipReason: "no-tool-outputs",
    };
  }

  const totalToolOutputTokens = toolEntries.reduce((s, e) => s + e.tokens, 0);

  // Step 3: Determine which to prune
  let prunedCount = 0;
  let tokensSaved = 0;
  const toPrune = new Set<string>();

  for (const entry of toolEntries) {
    if (remainingBudget <= 0) {
      toPrune.add(`${entry.msgIdx}:${entry.partIdx}`);
      prunedCount++;
      const args = argsById.get(entry.toolCallId);
      const placeholder = buildPlaceholderFromParts(
        entry.toolName,
        args,
        entry.output,
      );
      tokensSaved += entry.tokens - countTokens(placeholder);
      continue;
    }
    remainingBudget -= entry.tokens;
  }

  if (prunedCount === 0 || tokensSaved < minimumSavings) {
    return {
      messages,
      prunedCount: 0,
      tokensSaved: 0,
      totalToolOutputTokens,
      toolOutputCount: toolEntries.length,
      skipReason: prunedCount === 0 ? "within-budget" : "below-minimum-savings",
    };
  }

  // Step 4: Build new messages with pruned tool-result outputs
  const newMessages = messages.map((msg, mi) => {
    if (msg.role !== "tool") return msg;
    const content = msg.content as unknown[];
    if (!Array.isArray(content)) return msg;

    const hasPartsToPrune = content.some((_, pi) => toPrune.has(`${mi}:${pi}`));
    if (!hasPartsToPrune) return msg;

    const newContent = content.map((part, pi) => {
      if (!toPrune.has(`${mi}:${pi}`)) return part;

      const resultPart = part as ToolResultPart;
      const args = argsById.get(resultPart.toolCallId);
      const placeholder = buildPlaceholderFromParts(
        resultPart.toolName,
        args,
        resultPart.output,
      );

      return { ...resultPart, output: placeholder };
    });

    return { ...msg, content: newContent };
  });

  return {
    messages: newMessages,
    prunedCount,
    tokensSaved,
    totalToolOutputTokens,
    toolOutputCount: toolEntries.length,
    skipReason: null,
  };
}

/**
 * Filters out assistant messages with empty or whitespace-only content.
 *
 * convertToModelMessages() splits multi-step UIMessages at step-start boundaries.
 * When a step contains only reasoning (no text or tool calls), it produces an
 * assistant CoreMessage with content: [] — which strict providers like Moonshot AI
 * reject with "must not be empty" errors.
 *
 * Safe to remove (not patch) because reasoning-only steps have no tool calls,
 * so removing them won't orphan any subsequent tool messages.
 */
export function filterEmptyAssistantMessages<T extends Record<string, unknown>>(
  messages: T[],
): T[] {
  return messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    const content = msg.content;
    if (!Array.isArray(content)) return true;
    if (content.length === 0) return false;
    return content.some((part: any) => {
      if (part.type === "text") return !!part.text?.trim();
      return true; // tool-call, file, etc. are substantive
    });
  });
}
