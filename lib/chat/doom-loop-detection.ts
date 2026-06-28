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
export const EMPTY_TODO_WRITE_INPUT_WARNING_THRESHOLD = 2;
export const EMPTY_RUN_TERMINAL_CMD_INPUT_WARNING_THRESHOLD = 2;
const EMPTY_RUN_TERMINAL_CMD_INPUT_WINDOW = 8;

export type DoomLoopSeverity = "none" | "warning" | "halt";
export type DoomLoopReason =
  | "repeated_tool_call"
  | "empty_todo_write_input"
  | "empty_run_terminal_cmd_input";

export interface DoomLoopResult {
  severity: DoomLoopSeverity;
  toolNames: string[];
  consecutiveCount: number;
  reason?: DoomLoopReason;
  activeToolExclusions?: string[];
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

function isEmptyToolInput(input: unknown): boolean {
  if (input === undefined || input === null) return true;
  if (Array.isArray(input) || typeof input !== "object") return false;
  return Object.keys(input as Record<string, unknown>).length === 0;
}

function isEmptySingleToolStep(
  step: MinimalStep | undefined,
  toolName: string,
): boolean {
  if (!step?.toolCalls || step.toolCalls.length !== 1) return false;
  const [toolCall] = step.toolCalls;
  return isEmptyToolCall(toolCall, toolName);
}

function isEmptyToolCall(
  toolCall: MinimalToolCall | undefined,
  toolName: string,
): boolean {
  return toolCall?.toolName === toolName && isEmptyToolInput(toolCall.input);
}

function getTrailingEmptySingleToolCount(
  steps: MinimalStep[],
  toolName: string,
): number {
  let count = 0;

  for (let i = steps.length - 1; i >= 0; i--) {
    if (!isEmptySingleToolStep(steps[i], toolName)) break;
    count++;
  }

  return count;
}

function getRecentEmptySingleToolCount(
  steps: MinimalStep[],
  toolName: string,
  windowSize: number,
): number {
  let count = 0;

  for (const step of steps.slice(-windowSize)) {
    if (isEmptySingleToolStep(step, toolName)) count++;
  }

  return count;
}

function getRecentEmptyToolCallCount(
  steps: MinimalStep[],
  toolName: string,
  windowSize: number,
): number {
  let count = 0;

  for (const step of steps.slice(-windowSize)) {
    for (const toolCall of step.toolCalls ?? []) {
      if (isEmptyToolCall(toolCall, toolName)) count++;
    }
  }

  return count;
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

  const emptyTodoWriteCount = getTrailingEmptySingleToolCount(
    steps,
    "todo_write",
  );
  if (emptyTodoWriteCount >= EMPTY_TODO_WRITE_INPUT_WARNING_THRESHOLD) {
    return {
      severity:
        emptyTodoWriteCount >= DOOM_LOOP_HALT_THRESHOLD ? "halt" : "warning",
      toolNames: ["todo_write"],
      consecutiveCount: emptyTodoWriteCount,
      reason: "empty_todo_write_input",
      activeToolExclusions: ["todo_write"],
    };
  }

  const emptyRunTerminalCmdCount = getRecentEmptyToolCallCount(
    steps,
    "run_terminal_cmd",
    EMPTY_RUN_TERMINAL_CMD_INPUT_WINDOW,
  );
  if (
    emptyRunTerminalCmdCount >= EMPTY_RUN_TERMINAL_CMD_INPUT_WARNING_THRESHOLD
  ) {
    return {
      severity:
        emptyRunTerminalCmdCount >= DOOM_LOOP_HALT_THRESHOLD
          ? "halt"
          : "warning",
      toolNames: ["run_terminal_cmd"],
      consecutiveCount: emptyRunTerminalCmdCount,
      reason: "empty_run_terminal_cmd_input",
      activeToolExclusions: ["run_terminal_cmd"],
    };
  }

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
    reason: "repeated_tool_call",
  };
}

/**
 * Generates a nudge message to inject as a trailing user message when a doom
 * loop is detected. The message guides the model to break out of the loop.
 */
export function generateDoomLoopNudge(result: DoomLoopResult): string {
  const toolList = result.toolNames.join(", ");

  if (result.reason === "empty_todo_write_input") {
    return (
      `[TODO UPDATE SKIPPED] The last ${result.consecutiveCount} todo_write calls had empty arguments, so todo_write is unavailable for this step. ` +
      `Do NOT call todo_write again now. Continue the user's task with the current plan and other tools. ` +
      `Only try todo_write later if you can provide both top-level fields: merge and todos.`
    );
  }

  if (result.reason === "empty_run_terminal_cmd_input") {
    return (
      `[COMMAND SKIPPED] In the recent steps, ${result.consecutiveCount} run_terminal_cmd calls had empty arguments, so run_terminal_cmd is unavailable for this step. ` +
      `Do NOT call run_terminal_cmd again now. Continue with other tools, or explain the blocker if a terminal command is required. ` +
      `Only try run_terminal_cmd later if you can provide the required command field.`
    );
  }

  return (
    `[LOOP DETECTED] You have called ${toolList} ${result.consecutiveCount} times in a row with identical arguments. ` +
    `You are stuck in a loop and not making progress. You MUST try a DIFFERENT approach:\n` +
    `- If a command or tool keeps failing, read the error carefully and adjust your strategy\n` +
    `- Try different parameters, a different tool, or a different method entirely\n` +
    `- If you cannot make progress, explain what you've tried and ask the user for guidance\n` +
    `Do NOT repeat the same tool call again.`
  );
}
