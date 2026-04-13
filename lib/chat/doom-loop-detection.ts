/**
 * Doom Loop Detection
 *
 * Detects when the AI agent is stuck in a loop, repeatedly calling the same
 * tool(s) with identical arguments. Inspired by OpenCode's doom loop detection
 * (sst/opencode PR #3445).
 *
 * Two-tier response:
 * - Warning (3 consecutive identical steps): inject a nudge as a user message
 * - Halt (5 consecutive identical steps): stop generation entirely
 */

export const DOOM_LOOP_WARNING_THRESHOLD = 3;
export const DOOM_LOOP_HALT_THRESHOLD = 5;

export type DoomLoopSeverity = "none" | "warning" | "halt";

export interface DoomLoopResult {
  severity: DoomLoopSeverity;
  toolNames: string[];
  consecutiveCount: number;
}

interface MinimalToolCall {
  toolName: string;
  input?: unknown;
}

export interface MinimalStep {
  toolCalls: MinimalToolCall[];
}

// Fields in tool inputs that are cosmetic descriptions (change each call even
// when the functional arguments are identical). Stripped before fingerprinting.
const COSMETIC_INPUT_FIELDS = new Set(["brief", "explanation"]);

function stripCosmeticFields(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const entries = Object.entries(input as Record<string, unknown>).filter(
    ([key]) => !COSMETIC_INPUT_FIELDS.has(key),
  );
  return Object.fromEntries(entries);
}

/**
 * Creates a deterministic fingerprint for a step's tool calls.
 * Steps with no tool calls return a sentinel that breaks any loop chain.
 * Strips cosmetic fields (brief, explanation) that change per-call.
 */
export function createStepFingerprint(step: MinimalStep): string {
  if (!step.toolCalls || step.toolCalls.length === 0) {
    return "__no_tools__";
  }

  const sorted = [...step.toolCalls]
    .map((tc) => ({
      toolName: tc.toolName,
      input: stripCosmeticFields(tc.input),
    }))
    .sort((a, b) => a.toolName.localeCompare(b.toolName));

  return JSON.stringify(sorted);
}

/**
 * Detects doom loops by counting trailing identical step fingerprints.
 */
export function detectDoomLoop(steps: MinimalStep[]): DoomLoopResult {
  const none: DoomLoopResult = {
    severity: "none",
    toolNames: [],
    consecutiveCount: 0,
  };

  if (steps.length < DOOM_LOOP_WARNING_THRESHOLD) {
    return none;
  }

  // Get fingerprint of the last step
  const lastStep = steps[steps.length - 1];
  const lastFingerprint = createStepFingerprint(lastStep);

  // No-tool steps can't form a doom loop
  if (lastFingerprint === "__no_tools__") {
    return none;
  }

  // Count how many trailing steps share the same fingerprint
  let count = 1;
  for (let i = steps.length - 2; i >= 0; i--) {
    if (createStepFingerprint(steps[i]) === lastFingerprint) {
      count++;
    } else {
      break;
    }
  }

  if (count < DOOM_LOOP_WARNING_THRESHOLD) {
    return none;
  }

  const toolNames = [...new Set(lastStep.toolCalls.map((tc) => tc.toolName))];

  return {
    severity: count >= DOOM_LOOP_HALT_THRESHOLD ? "halt" : "warning",
    toolNames,
    consecutiveCount: count,
  };
}

/**
 * Generates a nudge message to inject as a trailing user message when a doom
 * loop is detected. The message guides the model to break out of the loop.
 */
export function generateDoomLoopNudge(result: DoomLoopResult): string {
  const toolList = result.toolNames.join(", ");

  return (
    `[LOOP DETECTED] You have called ${toolList} ${result.consecutiveCount} times in a row with identical arguments. ` +
    `You are stuck in a loop and not making progress. You MUST try a DIFFERENT approach:\n` +
    `- If a command or tool keeps failing, read the error carefully and adjust your strategy\n` +
    `- Try different parameters, a different tool, or a different method entirely\n` +
    `- If you cannot make progress, explain what you've tried and ask the user for guidance\n` +
    `Do NOT repeat the same tool call again.`
  );
}
