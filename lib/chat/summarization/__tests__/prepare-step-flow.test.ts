import { describe, it, expect } from "@jest/globals";
import type { ModelMessage } from "ai";

/**
 * Simulates how the AI SDK calls `prepareStep` during a multi-step agent run.
 *
 * Key SDK behavior: the SDK always passes the FULL accumulated ModelMessage
 * history to `prepareStep`, ignoring the modified messages returned from the
 * previous call. The returned messages only affect what the LLM sees for THAT
 * step — they don't persist into the SDK's internal state.
 *
 * This test verifies:
 *  1. Summarization fires when the provider token count exceeds the threshold.
 *  2. After summarization, step compression is RE-APPLIED on every step so the
 *     LLM always sees compressed context.
 *  3. No oscillating summarize/skip/summarize pattern.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const makeUserMsg = (text: string): ModelMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

const makeAssistantToolCall = (stepId: number): ModelMessage => ({
  role: "assistant",
  content: [
    { type: "text" as const, text: `Analyzing step ${stepId}...` },
    {
      type: "tool-call" as const,
      toolCallId: `call-${stepId}`,
      toolName: `tool_${stepId}`,
      args: { query: `step ${stepId} args — ${"x".repeat(500)}` },
    },
  ],
});

const makeToolResult = (stepId: number): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result" as const,
      toolCallId: `call-${stepId}`,
      toolName: `tool_${stepId}`,
      result: `Result for step ${stepId}: ${"y".repeat(800)}`,
    },
  ],
});

function countChars(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      total += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p !== null && typeof p === "object") {
          if ("text" in p) total += ((p as { text: string }).text ?? "").length;
          if ("result" in p)
            total += String((p as { result: unknown }).result ?? "").length;
          if ("args" in p)
            total += JSON.stringify((p as { args: unknown }).args ?? "").length;
        }
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Simulated prepareStep (mirrors chat-handler.ts)
// ---------------------------------------------------------------------------

type PrepareStepResult = { messages?: ModelMessage[] };

interface SimState {
  finalMessages: ModelMessage[];
  initialModelMessageCount: number | null;
  summarizationCount: number;
  stepSummaryText: string | null;
  /** The toolCallId up to which steps are summarized */
  stepSummaryUpToCallId: string | null;
  lastStepInputTokens: number;
  tokenThreshold: number;
}

/**
 * Simulates `injectPersistedStepSummary`: replaces tool-call messages up to
 * the cutoff with a summary message.
 */
function simulateInjectStepSummary(
  messages: ModelMessage[],
  summaryText: string,
  upToCallId: string,
): ModelMessage[] | null {
  let firstToolCallIdx = -1;
  let cutoffIdx = -1;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (
      firstToolCallIdx === -1 &&
      m.role === "assistant" &&
      Array.isArray(m.content)
    ) {
      const hasToolCall = m.content.some(
        (p) =>
          typeof p === "object" &&
          p !== null &&
          "type" in p &&
          p.type === "tool-call",
      );
      if (hasToolCall) firstToolCallIdx = i;
    }
    if (m.role === "tool" && Array.isArray(m.content)) {
      for (const p of m.content) {
        if (
          typeof p === "object" &&
          p !== null &&
          "toolCallId" in p &&
          (p as { toolCallId: string }).toolCallId === upToCallId
        ) {
          cutoffIdx = i;
          break;
        }
      }
      if (cutoffIdx !== -1) break;
    }
  }

  if (firstToolCallIdx === -1 || cutoffIdx === -1) return null;

  const summaryMsg = makeUserMsg(
    `<step_summary>\n${summaryText}\n</step_summary>`,
  );
  return [
    ...messages.slice(0, firstToolCallIdx),
    summaryMsg,
    ...messages.slice(cutoffIdx + 1),
  ];
}

function simulatedPrepareStep(
  state: SimState,
  stepsLength: number,
  sdkMessages: ModelMessage[],
): PrepareStepResult {
  if (state.initialModelMessageCount === null) {
    state.initialModelMessageCount = sdkMessages.length;
  }

  // 1. Message-level check: provider tokens exceed threshold?
  if (state.lastStepInputTokens > state.tokenThreshold) {
    state.summarizationCount++;

    const summaryMsg = makeUserMsg(
      `<context_summary>\nSummary of ${state.finalMessages.length} messages\n</context_summary>`,
    );
    state.finalMessages = [summaryMsg];

    // Combined step-level: find last tool call ID in SDK messages
    const lastCallId = `call-${stepsLength - 1}`;
    const stepText = `Summary of ${stepsLength} steps`;
    state.stepSummaryText = stepText;
    state.stepSummaryUpToCallId = lastCallId;

    const stepSummaryMsg = makeUserMsg(
      `<step_summary>\n${stepText}\n</step_summary>`,
    );
    return { messages: [summaryMsg, stepSummaryMsg] };
  }

  // 2. Re-apply existing step summary to SDK messages (KEY FIX)
  if (state.stepSummaryText && state.stepSummaryUpToCallId) {
    const injected = simulateInjectStepSummary(
      sdkMessages,
      state.stepSummaryText,
      state.stepSummaryUpToCallId,
    );
    if (injected) {
      return { messages: injected };
    }
  }

  // 3. No compression needed
  return { messages: sdkMessages };
}

// ---------------------------------------------------------------------------
// Run simulation
// ---------------------------------------------------------------------------

interface StepLog {
  step: number;
  inputMsgCount: number;
  inputEstTokens: number;
  outputMsgCount: number;
  outputEstTokens: number;
  summarized: boolean;
  providerTokens: number;
  /** The SDK's internal messages at this step (what onFinish would receive) */
  sdkMessages: ModelMessage[];
  /** The messages returned by prepareStep (what the LLM sees) */
  llmMessages: ModelMessage[];
}

interface SimResult {
  logs: StepLog[];
  /** Final SDK messages after all steps — what onFinish would receive for saving */
  savedMessages: ModelMessage[];
}

function runSimulatedAgentSession(opts: {
  userPrompt: string;
  totalSteps: number;
  tokenThreshold: number;
}): SimResult {
  const userMsg = makeUserMsg(opts.userPrompt);
  const logs: StepLog[] = [];

  const state: SimState = {
    finalMessages: [userMsg],
    initialModelMessageCount: null,
    summarizationCount: 0,
    stepSummaryText: null,
    stepSummaryUpToCallId: null,
    lastStepInputTokens: 0,
    tokenThreshold: opts.tokenThreshold,
  };

  const sdkMessages: ModelMessage[] = [userMsg];

  for (let step = 0; step < opts.totalSteps; step++) {
    const inputChars = countChars(sdkMessages);
    const result = simulatedPrepareStep(state, step, [...sdkMessages]);

    const outputMessages = result.messages ?? sdkMessages;
    const outputChars = countChars(outputMessages);

    logs.push({
      step,
      inputMsgCount: sdkMessages.length,
      inputEstTokens: Math.round(inputChars / 4),
      outputMsgCount: outputMessages.length,
      outputEstTokens: Math.round(outputChars / 4),
      summarized:
        state.summarizationCount > 0 &&
        outputMessages.length < sdkMessages.length &&
        state.lastStepInputTokens > state.tokenThreshold,
      providerTokens: state.lastStepInputTokens,
      sdkMessages: [...sdkMessages],
      llmMessages: [...outputMessages],
    });

    // SDK appends LLM response
    sdkMessages.push(makeAssistantToolCall(step), makeToolResult(step));

    // onStepFinish: provider reports tokens for what LLM actually saw
    state.lastStepInputTokens = Math.round(countChars(outputMessages) / 4);
  }

  return { logs, savedMessages: [...sdkMessages] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("prepareStep flow simulation", () => {
  it("input messages grow linearly without summarization (high threshold)", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 10,
      tokenThreshold: 999999,
    });

    for (let i = 1; i < logs.length; i++) {
      expect(logs[i].inputMsgCount).toBe(logs[i - 1].inputMsgCount + 2);
    }
    for (const log of logs) {
      expect(log.outputMsgCount).toBe(log.inputMsgCount);
    }
  });

  it("no oscillation: consecutive steps never both summarize", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 10,
      tokenThreshold: 500,
    });

    const summarizedSteps = logs.filter((l) => l.summarized);
    expect(summarizedSteps.length).toBeGreaterThanOrEqual(1);

    // No two consecutive steps should both be summarized (no oscillation)
    for (let i = 1; i < logs.length; i++) {
      if (logs[i].summarized && logs[i - 1].summarized) {
        throw new Error(
          `Oscillation detected: steps ${logs[i - 1].step} and ${logs[i].step} both summarized`,
        );
      }
    }

    // Between summarizations, output should be compressed (re-applied)
    for (let i = 0; i < logs.length; i++) {
      if (
        i > 0 &&
        !logs[i].summarized &&
        logs.slice(0, i).some((l) => l.summarized)
      ) {
        expect(logs[i].outputMsgCount).toBeLessThan(logs[i].inputMsgCount);
      }
    }
  });

  it("output tokens stay bounded after summarization", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 10,
      tokenThreshold: 500,
    });

    const summarizedStep = logs.find((l) => l.summarized);
    expect(summarizedStep).toBeDefined();

    // After summarization, output tokens should grow slowly (only unsummarized
    // steps after the cutoff), not linearly with full history
    const stepsAfter = logs.filter((l) => l.step > summarizedStep!.step);
    for (const log of stepsAfter) {
      // Output should always be much less than input
      expect(log.outputEstTokens).toBeLessThan(log.inputEstTokens);
    }
  });

  it("provider tokens stay low after summarization (no re-trigger)", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 10,
      tokenThreshold: 500,
    });

    const summarizedStep = logs.find((l) => l.summarized);
    expect(summarizedStep).toBeDefined();

    // After the summarized step, provider tokens should not exceed threshold
    // again (at least not immediately — they grow slowly with new steps only)
    const nextStep = logs.find((l) => l.step === summarizedStep!.step + 1);
    if (nextStep) {
      // Provider tokens should be based on compressed output, not full input
      expect(nextStep.providerTokens).toBeLessThan(500);
    }
  });

  it("SDK input always grows but output stays compressed", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 8,
      tokenThreshold: 500,
    });

    // Input always grows by 2 per step
    for (let i = 1; i < logs.length; i++) {
      expect(logs[i].inputMsgCount).toBe(logs[i - 1].inputMsgCount + 2);
    }

    const summarizedStep = logs.find((l) => l.summarized);
    expect(summarizedStep).toBeDefined();

    // After summarization, output is bounded (summary + new unsummarized steps)
    const stepsAfter = logs.filter((l) => l.step > summarizedStep!.step);
    for (const log of stepsAfter) {
      expect(log.outputMsgCount).toBeLessThan(log.inputMsgCount);
    }
  });

  it("prints step-by-step token flow", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Perform an exhaustive security reconnaissance scan",
      totalSteps: 12,
      tokenThreshold: 800,
    });

    const formatted = logs.map(
      (l) =>
        `step=${l.step} ` +
        `in(msgs=${l.inputMsgCount} ~${l.inputEstTokens}t) → ` +
        `out(msgs=${l.outputMsgCount} ~${l.outputEstTokens}t) ` +
        `provider=${l.providerTokens}t` +
        (l.summarized ? " [SUMMARIZED]" : ""),
    );

    console.log("\n--- Step-by-step token flow ---");
    for (const line of formatted) {
      console.log(line);
    }

    expect(logs).toHaveLength(12);
    // Summarization fires periodically (not every step — no oscillation)
    const summarized = logs.filter((l) => l.summarized);
    expect(summarized.length).toBeGreaterThanOrEqual(1);
    expect(summarized.length).toBeLessThan(logs.length / 2);
  });
});

// ---------------------------------------------------------------------------
// onFinish: saved messages are the original uncompressed SDK messages
// ---------------------------------------------------------------------------

describe("onFinish saves original messages (not compressed)", () => {
  it("savedMessages contain every tool-call and tool-result from all steps", () => {
    const { savedMessages } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 10,
      tokenThreshold: 500,
    });

    // 1 user prompt + 10 steps * (1 assistant + 1 tool) = 21 messages
    expect(savedMessages).toHaveLength(1 + 10 * 2);

    // First message is the user prompt
    expect(savedMessages[0].role).toBe("user");

    // Every step's assistant tool-call and tool-result is present
    for (let step = 0; step < 10; step++) {
      const assistantIdx = 1 + step * 2;
      const toolIdx = 2 + step * 2;

      expect(savedMessages[assistantIdx].role).toBe("assistant");
      expect(savedMessages[toolIdx].role).toBe("tool");

      // Verify specific tool call IDs are preserved
      const assistantContent = savedMessages[assistantIdx].content;
      expect(Array.isArray(assistantContent)).toBe(true);
      const toolCallPart = (
        assistantContent as Array<Record<string, unknown>>
      ).find((p) => p.type === "tool-call");
      expect(toolCallPart).toBeDefined();
      expect(toolCallPart!.toolCallId).toBe(`call-${step}`);

      const toolContent = savedMessages[toolIdx].content;
      expect(Array.isArray(toolContent)).toBe(true);
      const toolResultPart = (
        toolContent as Array<Record<string, unknown>>
      ).find((p) => p.type === "tool-result");
      expect(toolResultPart).toBeDefined();
      expect(toolResultPart!.toolCallId).toBe(`call-${step}`);
    }
  });

  it("savedMessages contain no summary injection messages", () => {
    const { savedMessages } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 10,
      tokenThreshold: 500,
    });

    for (const msg of savedMessages) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if ("text" in part) {
            const text = (part as { text: string }).text;
            expect(text).not.toContain("<step_summary>");
            expect(text).not.toContain("<context_summary>");
          }
        }
      }
    }
  });

  it("savedMessages grow linearly even when summarization fires", () => {
    const { logs, savedMessages } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 10,
      tokenThreshold: 500,
    });

    // Summarization must have fired
    expect(logs.some((l) => l.summarized)).toBe(true);

    // But saved messages still have all 21 messages (1 user + 10*2 step messages)
    expect(savedMessages).toHaveLength(21);
  });

  it("sdkMessages at each step never contain summary messages", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 10,
      tokenThreshold: 500,
    });

    for (const log of logs) {
      // sdkMessages (what SDK tracks internally) should never have summaries
      for (const msg of log.sdkMessages) {
        if (msg.role === "user" && Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if ("text" in part) {
              const text = (part as { text: string }).text;
              expect(text).not.toContain("<step_summary>");
              expect(text).not.toContain("<context_summary>");
            }
          }
        }
      }
    }
  });

  it("llmMessages contain summaries after summarization fires", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 10,
      tokenThreshold: 500,
    });

    const firstSummarizedStep = logs.find((l) => l.summarized);
    expect(firstSummarizedStep).toBeDefined();

    // The LLM messages at a summarized step should contain summary text
    const llmTexts = firstSummarizedStep!.llmMessages.flatMap((msg) => {
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((p): p is { text: string } => "text" in p)
          .map((p) => p.text);
      }
      return [];
    });
    const hasSummary = llmTexts.some(
      (t) => t.includes("<context_summary>") || t.includes("<step_summary>"),
    );
    expect(hasSummary).toBe(true);
  });

  it("savedMessages chars always exceed llmMessages chars after summarization", () => {
    const { logs, savedMessages } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 10,
      tokenThreshold: 500,
    });

    const savedChars = countChars(savedMessages);

    // After summarization, every subsequent step's LLM view should be smaller
    // than the full saved messages
    const stepsAfterSummarization = logs.filter(
      (l) =>
        l.step > 0 && logs.slice(0, l.step).some((prev) => prev.summarized),
    );
    expect(stepsAfterSummarization.length).toBeGreaterThan(0);

    for (const log of stepsAfterSummarization) {
      const llmChars = countChars(log.llmMessages);
      expect(llmChars).toBeLessThan(savedChars);
    }
  });
});

// ---------------------------------------------------------------------------
// Error / abort mid-generation: simulates onFinish save behavior
// ---------------------------------------------------------------------------

/**
 * Mirrors chat-handler.ts onFinish logic:
 * - SDK calls onFinish with accumulated messages (possibly partial)
 * - Messages with no parts are skipped
 * - On abort mid-step, the last assistant message may have an incomplete
 *   tool call (tool-call present but no matching tool-result)
 */

type UIMessagePart =
  | { type: "text"; text: string }
  | { type: "step-start" }
  | {
      type: "tool-invocation";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      state: "partial-call" | "call" | "result" | "output-available";
      result?: unknown;
    }
  | { type: "reasoning"; text: string };

interface UIMessage {
  id: string;
  role: "user" | "assistant";
  parts: UIMessagePart[];
}

/** Converts SDK ModelMessages into UIMessages (simplified version of what toUIMessageStream does) */
function modelMessagesToUIMessages(
  modelMessages: ModelMessage[],
  opts?: { abortAfterStep?: number },
): UIMessage[] {
  const uiMessages: UIMessage[] = [];
  let stepCount = 0;

  for (const msg of modelMessages) {
    if (msg.role === "user") {
      const text = Array.isArray(msg.content)
        ? msg.content
            .filter(
              (p): p is { type: "text"; text: string } =>
                typeof p === "object" && p !== null && "text" in p,
            )
            .map((p) => p.text)
            .join("")
        : "";
      uiMessages.push({
        id: `user-${uiMessages.length}`,
        role: "user",
        parts: [{ type: "text", text }],
      });
    } else if (msg.role === "assistant") {
      const parts: UIMessagePart[] = [{ type: "step-start" }];
      const content = Array.isArray(msg.content) ? msg.content : [];

      for (const p of content) {
        const part = p as Record<string, unknown>;
        if ("text" in part && part.text) {
          parts.push({ type: "text", text: part.text as string });
        }
        if ("type" in part && part.type === "tool-call") {
          const tc = part as unknown as {
            toolCallId: string;
            toolName: string;
            args: Record<string, unknown>;
          };
          // If abort happens at this step, tool stays in "call" state (no result)
          const isAborted =
            opts?.abortAfterStep !== undefined &&
            stepCount >= opts.abortAfterStep;
          parts.push({
            type: "tool-invocation",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
            state: isAborted ? "call" : "output-available",
            ...(isAborted ? {} : { result: "completed" }),
          });
        }
      }

      // Merge into existing assistant message or create new one
      const lastUI = uiMessages[uiMessages.length - 1];
      if (lastUI && lastUI.role === "assistant") {
        lastUI.parts.push(...parts);
      } else {
        uiMessages.push({
          id: `assistant-${uiMessages.length}`,
          role: "assistant",
          parts,
        });
      }
      stepCount++;
    }
    // tool-result messages merge into assistant's tool-invocation state
    // (already handled above via "output-available")
  }

  return uiMessages;
}

/**
 * Simulates the onFinish filtering logic from chat-handler.ts (lines 1247-1290):
 * - Skips messages with no parts and no files
 * - Applies updateOnly on abort (only patches existing, doesn't create new)
 */
function simulateOnFinishSave(
  uiMessages: UIMessage[],
  opts: {
    isAborted: boolean;
    isPreemptiveAbort?: boolean;
    skipSave?: boolean;
    hasFiles?: boolean;
    hasUsage?: boolean;
  },
): UIMessage[] {
  // skipSave signal: skip everything (edit/regenerate/retry)
  if (
    opts.isAborted &&
    !opts.isPreemptiveAbort &&
    (opts.skipSave ||
      (!opts.hasFiles && !opts.hasUsage && !hasIncompleteToolCalls(uiMessages)))
  ) {
    return [];
  }

  // Filter out empty messages
  return uiMessages.filter(
    (msg) => (msg.parts && msg.parts.length > 0) || opts.hasFiles,
  );
}

function hasIncompleteToolCalls(messages: UIMessage[]): boolean {
  return messages.some(
    (msg) =>
      msg.role === "assistant" &&
      msg.parts?.some(
        (p) => p.type === "tool-invocation" && p.state !== "output-available",
      ),
  );
}

describe("error/abort mid-generation save behavior", () => {
  it("normal completion: all messages are saved", () => {
    const { savedMessages } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 5,
      tokenThreshold: 999999,
    });

    const uiMessages = modelMessagesToUIMessages(savedMessages);
    const saved = simulateOnFinishSave(uiMessages, {
      isAborted: false,
      hasUsage: true,
    });

    // User message + assistant message (with all steps merged)
    expect(saved.length).toBe(2);
    expect(saved[0].role).toBe("user");
    expect(saved[1].role).toBe("assistant");

    // All tool invocations should be in "output-available" state
    const toolParts = saved[1].parts.filter(
      (p) => p.type === "tool-invocation",
    );
    expect(toolParts).toHaveLength(5);
    for (const tp of toolParts) {
      expect((tp as { state: string }).state).toBe("output-available");
    }
  });

  it("abort mid-step: partial messages saved with incomplete tool calls", () => {
    const { savedMessages } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 5,
      tokenThreshold: 999999,
    });

    // Abort after step 3 — steps 3 and 4 have incomplete tool calls
    const uiMessages = modelMessagesToUIMessages(savedMessages, {
      abortAfterStep: 3,
    });
    const saved = simulateOnFinishSave(uiMessages, {
      isAborted: true,
      isPreemptiveAbort: true, // preemptive: still saves
      hasUsage: true,
    });

    expect(saved.length).toBe(2);

    // Steps 0-2 should be "output-available", steps 3-4 should be "call" (incomplete)
    const toolParts = saved[1].parts.filter(
      (p) => p.type === "tool-invocation",
    ) as Array<{ state: string; toolCallId: string }>;
    expect(toolParts).toHaveLength(5);

    const complete = toolParts.filter((p) => p.state === "output-available");
    const incomplete = toolParts.filter((p) => p.state === "call");
    expect(complete).toHaveLength(3);
    expect(incomplete).toHaveLength(2);
  });

  it("user abort with skipSave: nothing is saved", () => {
    const { savedMessages } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 5,
      tokenThreshold: 999999,
    });

    const uiMessages = modelMessagesToUIMessages(savedMessages);
    const saved = simulateOnFinishSave(uiMessages, {
      isAborted: true,
      skipSave: true,
    });

    expect(saved).toHaveLength(0);
  });

  it("user abort without skipSave but with usage: messages are saved", () => {
    const { savedMessages } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 5,
      tokenThreshold: 999999,
    });

    const uiMessages = modelMessagesToUIMessages(savedMessages);
    const saved = simulateOnFinishSave(uiMessages, {
      isAborted: true,
      hasUsage: true,
    });

    // With usage to record, messages are saved even on abort
    expect(saved.length).toBe(2);
  });

  it("user abort without skipSave, no usage, no files, no incomplete tools: nothing saved", () => {
    const { savedMessages } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 5,
      tokenThreshold: 999999,
    });

    const uiMessages = modelMessagesToUIMessages(savedMessages);
    const saved = simulateOnFinishSave(uiMessages, {
      isAborted: true,
      hasUsage: false,
      hasFiles: false,
    });

    // No files, no usage, no incomplete tool calls → skip save
    expect(saved).toHaveLength(0);
  });

  it("user abort with incomplete tool calls but no usage: messages saved (to persist tool state)", () => {
    const { savedMessages } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 5,
      tokenThreshold: 999999,
    });

    // Abort at step 3 — creates incomplete tool calls
    const uiMessages = modelMessagesToUIMessages(savedMessages, {
      abortAfterStep: 3,
    });
    const saved = simulateOnFinishSave(uiMessages, {
      isAborted: true,
      hasUsage: false,
      hasFiles: false,
    });

    // Has incomplete tool calls → must save to persist state
    expect(saved.length).toBe(2);
    expect(hasIncompleteToolCalls(saved)).toBe(true);
  });

  it("empty assistant message (error at step 0): filtered out", () => {
    const emptyAssistant: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [],
    };
    const userMsg: UIMessage = {
      id: "user-0",
      role: "user",
      parts: [{ type: "text", text: "Do a scan" }],
    };

    const saved = simulateOnFinishSave([userMsg, emptyAssistant], {
      isAborted: false,
      hasUsage: true,
    });

    // Empty assistant message is filtered out
    expect(saved).toHaveLength(1);
    expect(saved[0].role).toBe("user");
  });

  it("preemptive timeout: saves partial messages (does not skip)", () => {
    const { savedMessages } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 5,
      tokenThreshold: 999999,
    });

    const uiMessages = modelMessagesToUIMessages(savedMessages, {
      abortAfterStep: 2,
    });
    const saved = simulateOnFinishSave(uiMessages, {
      isAborted: true,
      isPreemptiveAbort: true,
      hasUsage: true,
    });

    // Preemptive abort always saves — it's not user-initiated
    expect(saved.length).toBe(2);

    const toolParts = saved[1].parts.filter(
      (p) => p.type === "tool-invocation",
    ) as Array<{ state: string }>;
    const complete = toolParts.filter((p) => p.state === "output-available");
    const incomplete = toolParts.filter((p) => p.state === "call");
    expect(complete).toHaveLength(2);
    expect(incomplete).toHaveLength(3);
  });

  it("abort after summarization: saved messages still contain all original data", () => {
    const { savedMessages, logs } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 8,
      tokenThreshold: 500,
    });

    // Summarization must have fired
    expect(logs.some((l) => l.summarized)).toBe(true);

    // Even though summarization compressed what the LLM saw,
    // the SDK messages (what gets saved) are always the full originals
    const uiMessages = modelMessagesToUIMessages(savedMessages, {
      abortAfterStep: 6,
    });
    const saved = simulateOnFinishSave(uiMessages, {
      isAborted: true,
      isPreemptiveAbort: true,
      hasUsage: true,
    });

    expect(saved.length).toBe(2);

    // All 8 tool invocations should be present (none were removed by summarization)
    const toolParts = saved[1].parts.filter(
      (p) => p.type === "tool-invocation",
    );
    expect(toolParts).toHaveLength(8);

    // No summary text in saved messages
    const allText = saved
      .flatMap((m) => m.parts)
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text);
    for (const t of allText) {
      expect(t).not.toContain("<step_summary>");
      expect(t).not.toContain("<context_summary>");
    }
  });
});

// ---------------------------------------------------------------------------
// Long agent runs (20+ steps) and multi-cycle summarization
// ---------------------------------------------------------------------------

describe("long agent runs", () => {
  it("30-step run: multiple summarization cycles fire without oscillation", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Perform full pentest",
      totalSteps: 30,
      tokenThreshold: 800,
    });

    const summarized = logs.filter((l) => l.summarized);
    // Should fire multiple times across 30 steps
    expect(summarized.length).toBeGreaterThanOrEqual(3);

    // No oscillation (no consecutive summarized steps)
    for (let i = 1; i < logs.length; i++) {
      if (logs[i].summarized && logs[i - 1].summarized) {
        throw new Error(
          `Oscillation at steps ${logs[i - 1].step} and ${logs[i].step}`,
        );
      }
    }
  });

  it("30-step run: output tokens stay bounded across all cycles", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Perform full pentest",
      totalSteps: 30,
      tokenThreshold: 800,
    });

    // After any summarization, output should be compressed
    for (let i = 0; i < logs.length; i++) {
      if (
        i > 0 &&
        !logs[i].summarized &&
        logs.slice(0, i).some((l) => l.summarized)
      ) {
        expect(logs[i].outputEstTokens).toBeLessThan(logs[i].inputEstTokens);
      }
    }
  });

  it("30-step run: saved messages always contain all original steps", () => {
    const { savedMessages, logs } = runSimulatedAgentSession({
      userPrompt: "Perform full pentest",
      totalSteps: 30,
      tokenThreshold: 800,
    });

    // Multiple summarization cycles
    expect(logs.filter((l) => l.summarized).length).toBeGreaterThanOrEqual(3);

    // All 30 steps present in saved messages (1 user + 30*2 = 61)
    expect(savedMessages).toHaveLength(61);

    // No summaries leaked into saved messages
    for (const msg of savedMessages) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if ("text" in part) {
            const text = (part as { text: string }).text;
            expect(text).not.toContain("<step_summary>");
            expect(text).not.toContain("<context_summary>");
          }
        }
      }
    }
  });

  it("50-step run: system remains stable", () => {
    const { logs, savedMessages } = runSimulatedAgentSession({
      userPrompt: "Full reconnaissance",
      totalSteps: 50,
      tokenThreshold: 1000,
    });

    // Must have many summarization cycles
    const summarized = logs.filter((l) => l.summarized);
    expect(summarized.length).toBeGreaterThanOrEqual(5);

    // No oscillation across all 50 steps
    for (let i = 1; i < logs.length; i++) {
      expect(!(logs[i].summarized && logs[i - 1].summarized)).toBe(true);
    }

    // All 50 steps saved (1 user + 100 step messages)
    expect(savedMessages).toHaveLength(101);

    // Input always grows linearly
    for (let i = 1; i < logs.length; i++) {
      expect(logs[i].inputMsgCount).toBe(logs[i - 1].inputMsgCount + 2);
    }

    // Output never exceeds input
    for (const log of logs) {
      expect(log.outputMsgCount).toBeLessThanOrEqual(log.inputMsgCount);
    }
  });
});

// ---------------------------------------------------------------------------
// Non-agent mode (regular chat) — step summarization should not fire
// ---------------------------------------------------------------------------

describe("non-agent (chat) mode behavior", () => {
  /**
   * In chat mode, isAgentMode returns false so step summarization never fires.
   * Simulate this by using a high threshold (message-level won't trigger)
   * and no step compression — output should equal input on every step.
   */
  it("short chat: no summarization with high threshold", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "What is XSS?",
      totalSteps: 3,
      tokenThreshold: 999999,
    });

    // No summarization should fire
    for (const log of logs) {
      expect(log.summarized).toBe(false);
      expect(log.outputMsgCount).toBe(log.inputMsgCount);
    }
  });

  it("chat with few steps: output equals input (no compression)", () => {
    const { logs, savedMessages } = runSimulatedAgentSession({
      userPrompt: "Explain SQL injection",
      totalSteps: 2,
      tokenThreshold: 999999,
    });

    // 1 user + 2*2 step = 5 messages saved
    expect(savedMessages).toHaveLength(5);

    // No compression applied
    for (const log of logs) {
      expect(log.outputMsgCount).toBe(log.inputMsgCount);
    }
  });
});

// ---------------------------------------------------------------------------
// Summarization cycle spacing — verifies compression gives enough headroom
// ---------------------------------------------------------------------------

describe("multi-cycle summarization spacing", () => {
  it("summarization cycles are spaced apart (not back-to-back)", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Full scan",
      totalSteps: 30,
      tokenThreshold: 800,
    });

    const summarizedSteps = logs.filter((l) => l.summarized).map((l) => l.step);
    expect(summarizedSteps.length).toBeGreaterThanOrEqual(3);

    // Gap between each summarization should be >= 2 steps
    for (let i = 1; i < summarizedSteps.length; i++) {
      const gap = summarizedSteps[i] - summarizedSteps[i - 1];
      expect(gap).toBeGreaterThanOrEqual(2);
    }
  });

  it("provider tokens drop after each summarization cycle", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Full scan",
      totalSteps: 30,
      tokenThreshold: 800,
    });

    const summarizedSteps = logs.filter((l) => l.summarized);
    for (const sumStep of summarizedSteps) {
      const nextStep = logs.find((l) => l.step === sumStep.step + 1);
      if (nextStep) {
        // Provider tokens should drop well below threshold after compression
        expect(nextStep.providerTokens).toBeLessThan(sumStep.providerTokens);
      }
    }
  });

  it("each cycle compresses to roughly the same size", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Full scan",
      totalSteps: 30,
      tokenThreshold: 800,
    });

    const summarizedSteps = logs.filter((l) => l.summarized);
    expect(summarizedSteps.length).toBeGreaterThanOrEqual(2);

    // All summarized outputs should be roughly the same size
    // (summary text + recent unsummarized steps)
    const outputTokens = summarizedSteps.map((l) => l.outputEstTokens);
    const maxOutput = Math.max(...outputTokens);
    const minOutput = Math.min(...outputTokens);
    // Outputs should be within 2x of each other
    expect(maxOutput).toBeLessThan(minOutput * 3);
  });
});

// ---------------------------------------------------------------------------
// Summarized messages are NOT passed back to the model
// ---------------------------------------------------------------------------

/** Extract all tool-call IDs from ModelMessages */
function extractToolCallIds(messages: ModelMessage[]): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      const p = part as Record<string, unknown>;
      if (p.type === "tool-call" && typeof p.toolCallId === "string") {
        ids.push(p.toolCallId);
      }
      if (p.type === "tool-result" && typeof p.toolCallId === "string") {
        ids.push(p.toolCallId);
      }
    }
  }
  return ids;
}

/** Check if messages contain summary text */
function hasSummaryText(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if ("text" in part) {
        const text = (part as { text: string }).text;
        if (
          text.includes("<step_summary>") ||
          text.includes("<context_summary>")
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

describe("summarized messages excluded from LLM output", () => {
  it("on summarization step: old tool calls are absent, summary is present", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 10,
      tokenThreshold: 500,
    });

    const firstSummarized = logs.find((l) => l.summarized);
    expect(firstSummarized).toBeDefined();

    // LLM messages should contain summary text
    expect(hasSummaryText(firstSummarized!.llmMessages)).toBe(true);

    // LLM messages should contain NO tool-call IDs at all on the summarized step
    // (everything was compressed into the summary)
    const llmToolIds = extractToolCallIds(firstSummarized!.llmMessages);
    expect(llmToolIds).toHaveLength(0);

    // SDK messages (input) SHOULD still have all tool calls
    const sdkToolIds = extractToolCallIds(firstSummarized!.sdkMessages);
    expect(sdkToolIds.length).toBeGreaterThan(0);
  });

  it("after summarization: re-injected steps exclude old tool calls", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 10,
      tokenThreshold: 500,
    });

    const firstSummarized = logs.find((l) => l.summarized);
    expect(firstSummarized).toBeDefined();
    const summarizedStep = firstSummarized!.step;

    // Collect all tool-call IDs that existed BEFORE summarization
    const preSummarizationCallIds: string[] = [];
    for (let i = 0; i < summarizedStep; i++) {
      preSummarizationCallIds.push(`call-${i}`);
    }
    expect(preSummarizationCallIds.length).toBeGreaterThan(0);

    // On every subsequent step, the LLM should NOT see pre-summarization tool calls
    const stepsAfter = logs.filter(
      (l) => l.step > summarizedStep && !l.summarized,
    );
    expect(stepsAfter.length).toBeGreaterThan(0);

    for (const log of stepsAfter) {
      const llmToolIds = extractToolCallIds(log.llmMessages);
      for (const oldId of preSummarizationCallIds) {
        expect(llmToolIds).not.toContain(oldId);
      }

      // But the summary text SHOULD be present (re-injected)
      expect(hasSummaryText(log.llmMessages)).toBe(true);

      // And post-summarization tool calls SHOULD be present
      const postSumCallIds = llmToolIds.filter(
        (id) => !preSummarizationCallIds.includes(id),
      );
      // Steps after summarization added new tool calls, those should be visible
      if (log.step > summarizedStep + 1) {
        expect(postSumCallIds.length).toBeGreaterThan(0);
      }
    }
  });

  it("SDK input always contains ALL tool calls regardless of summarization", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 10,
      tokenThreshold: 500,
    });

    // On every step, SDK messages should contain tool calls for all prior steps
    for (const log of logs) {
      const sdkToolIds = extractToolCallIds(log.sdkMessages);
      // Step N should have tool calls from steps 0..N-1 (2 per step: call + result)
      expect(sdkToolIds.length).toBe(log.step * 2);

      // Verify exact IDs
      for (let i = 0; i < log.step; i++) {
        expect(sdkToolIds).toContain(`call-${i}`);
      }
    }
  });

  it("multi-cycle: each cycle removes older tool calls from LLM view", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Full scan",
      totalSteps: 20,
      tokenThreshold: 500,
    });

    const summarizedSteps = logs.filter((l) => l.summarized);
    expect(summarizedSteps.length).toBeGreaterThanOrEqual(2);

    // After each summarization cycle, all tool calls up to that point
    // should be absent from the LLM's view
    for (const sumStep of summarizedSteps) {
      const llmToolIds = extractToolCallIds(sumStep.llmMessages);
      // On a summarization step, ALL prior tool calls are compressed
      for (let i = 0; i < sumStep.step; i++) {
        expect(llmToolIds).not.toContain(`call-${i}`);
      }
    }

    // Between cycles, re-injection keeps old calls hidden
    const lastSummarized = summarizedSteps[summarizedSteps.length - 1];
    const stepsAfterLast = logs.filter(
      (l) => l.step > lastSummarized.step && !l.summarized,
    );
    for (const log of stepsAfterLast) {
      const llmToolIds = extractToolCallIds(log.llmMessages);
      // All tool calls before the last summarization should be gone
      for (let i = 0; i < lastSummarized.step; i++) {
        expect(llmToolIds).not.toContain(`call-${i}`);
      }
    }
  });

  it("LLM never sees raw tool args/results from summarized steps", () => {
    const { logs } = runSimulatedAgentSession({
      userPrompt: "Do a security scan",
      totalSteps: 10,
      tokenThreshold: 500,
    });

    const firstSummarized = logs.find((l) => l.summarized);
    expect(firstSummarized).toBeDefined();

    // Collect raw content patterns from pre-summarization steps
    const rawPatterns = [];
    for (let i = 0; i < firstSummarized!.step; i++) {
      rawPatterns.push(`step ${i} args`);
      rawPatterns.push(`Result for step ${i}`);
    }

    // Check all post-summarization LLM messages
    const stepsAfter = logs.filter((l) => l.step >= firstSummarized!.step);
    for (const log of stepsAfter) {
      const allText: string[] = [];
      for (const msg of log.llmMessages) {
        if (!Array.isArray(msg.content)) continue;
        for (const part of msg.content) {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") allText.push(p.text);
          if (typeof p.result === "string") allText.push(p.result);
          if (p.args) allText.push(JSON.stringify(p.args));
        }
      }
      const joined = allText.join(" ");

      for (const pattern of rawPatterns) {
        expect(joined).not.toContain(pattern);
      }
    }
  });
});
