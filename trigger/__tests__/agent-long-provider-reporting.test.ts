/**
 * Max Agent provider failure -> recovery -> final stop causality, using the
 * same helpers and order as agent-long: the failed leg's terminal error is
 * recorded before stream state resets, then the recovery leg ends.
 */
import fs from "node:fs";
import path from "node:path";
import { createAgentRunReporting } from "@/lib/analytics/agent-run-reporting";
import {
  getTerminalProviderStreamError,
  wrapProviderTerminalError,
} from "@/lib/api/provider-terminal-error";
import { getRetryFallbackModel } from "@/lib/api/chat-stream-helpers";
import { LocalConnectionLostError } from "@/lib/chat/local-connection-stop";
import { prepareProviderDisconnectContinuation } from "@/lib/chat/agent-long-provider-retry";
import { UsageTracker } from "@/lib/usage-tracker";
import type { UIMessage } from "ai";

(globalThis as any).Request = class Request {};
(globalThis as any).Response = class Response {};
(globalThis as any).Headers = class Headers {};

jest.mock("@/lib/db/actions", () => ({ getNotes: jest.fn() }));

const { captureAgentCompletionAnalytics } = require("@/lib/api/chat-logger");

const RUN_ID = "run_synthetic_recovery";

function startMaxRun({ failFirstCapture = false } = {}) {
  let failNext = failFirstCapture;
  const capture = jest.fn(() => {
    if (failNext) {
      failNext = false;
      throw new Error("enqueue unavailable");
    }
  });
  const posthog = { capture } as any;
  const metadata = new Map<string, unknown>();
  const reporting = createAgentRunReporting({
    posthog,
    runId: RUN_ID,
    userId: "user_synthetic",
    chatId: "chat_synthetic",
    subscription: "ultra",
    endpoint: "/api/agent",
    setRunMetadata: (key, value) => metadata.set(key, value),
  });
  // Grok finished with a provider content filter on the primary leg.
  const state: {
    providerError: unknown;
    streamFinishReason?: string;
  } = { providerError: undefined, streamFinishReason: "content-filter" };
  const retryModel = getRetryFallbackModel(
    "model-grok-4.6",
    "agent",
    "hackerai-max",
  );
  reporting.recordModelRecovery({
    reason: "content_filter",
    retryModel,
    failure: wrapProviderTerminalError(
      getTerminalProviderStreamError(state, false),
      { model: "x-ai/grok-4.6" },
    ),
  });
  // resetAgentStreamStateForRetry clears the failed leg's evidence.
  state.streamFinishReason = undefined;
  expect(getTerminalProviderStreamError(state, false)).toBeUndefined();

  const finishRecoveryLeg = (
    leg: Partial<Parameters<typeof captureAgentCompletionAnalytics>[0]>,
  ) =>
    reporting.captureTerminal(captureAgentCompletionAnalytics, {
      posthog,
      userId: "user_synthetic",
      chatId: "chat_synthetic",
      endpoint: "/api/agent",
      mode: "agent",
      subscription: "ultra",
      sandboxInfo: { type: "desktop" },
      hasResponseContent: false,
      chatLogger: undefined,
      selectedModel: "model-grok-4.6",
      configuredModelId: "x-ai/grok-4.6",
      responseModel: "deepseek/deepseek-v4.1-flash-20261017",
      fallbackServed: true,
      triggerRunId: RUN_ID,
      abliteratedProviderSummary: undefined,
      // Existing disconnect-only fields: a refusal never populated them.
      providerRecoveryAttempts: 0,
      providerRecoveryModels: [],
      providerRecoverySucceeded: false,
      ...leg,
    });
  const runEvents = () =>
    capture.mock.calls
      .map(([event]: any) => event)
      .filter((event: any) => event.event === "hackerai-agent_run");
  return { reporting, metadata, retryModel, finishRecoveryLeg, runEvents };
}

const refusalCause = {
  initial_provider_failure_category: "content_blocked",
  initial_provider_failure_model: "x-ai/grok-4.6",
  initial_provider_failure_status_code: 403,
  model_recovery_attempts: 1,
  model_recovery_models: ["model-deepseek-v4.1-flash-1017-pro"],
  model_recovery_reasons: ["content_filter"],
};

it.each([
  ["normal completion capture", false],
  ["run-finally fallback after a failed capture", true],
])(
  "retains Grok refusal -> DeepSeek recovery -> local stop through %s",
  (_name, failFirstCapture) => {
    const { reporting, metadata, retryModel, finishRecoveryLeg, runEvents } =
      startMaxRun({ failFirstCapture });
    expect(retryModel).toBe("model-deepseek-v4.1-flash-1017-pro");
    reporting.recordLocalStop(
      new LocalConnectionLostError("selected_host_left"),
    );
    finishRecoveryLeg({
      outcome: "aborted",
      abortSource: "unknown",
      finishReason: "local-connection-lost",
    });
    reporting.finalize({ canceled: false });

    const runs = runEvents();
    // The failed enqueue leaves exactly one fallback record from run finally.
    expect(runs).toHaveLength(failFirstCapture ? 2 : 1);
    const reported = runs.at(-1).properties;
    expect(reported).toMatchObject({
      ...refusalCause,
      outcome: "aborted",
      finish_reason: "local-connection-lost",
      abort_source: "unknown",
      local_stop_reason: "selected_host_left",
      model_recovery_succeeded: false,
    });
    expect(reported.terminal_reporting_source).toBe(
      failFirstCapture ? "run_finally" : undefined,
    );
    expect(Object.fromEntries(metadata)).toMatchObject({
      agentOutcome: "aborted",
      // The observed terminal outcome stands even when its enqueue failed.
      agentOutcomeSource: "completion",
      agentFinishReason: "local-connection-lost",
      agentAbortSource: "unknown",
      agentLocalStopReason: "selected_host_left",
      agentRecoverySucceeded: false,
      agentRecoveryAttempts: 1,
      agentRecoveryModel: "model-deepseek-v4.1-flash-1017-pro",
      agentRecoveryReason: "content_filter",
      agentProviderFailureCategory: "content_blocked",
      agentProviderFailureModel: "x-ai/grok-4.6",
      agentProviderFailureStatusCode: 403,
    });
  },
);

it("keeps a successful DeepSeek recovery successful with its refusal cause", () => {
  const { reporting, metadata, finishRecoveryLeg, runEvents } = startMaxRun();
  finishRecoveryLeg({
    outcome: "success",
    finishReason: "stop",
    hasResponseContent: true,
  });
  // A later stop during cleanup cannot relabel the completed response.
  reporting.recordLocalStop(new LocalConnectionLostError("selected_host_left"));
  reporting.finalize({ canceled: false });
  const runs = runEvents();
  expect(runs).toHaveLength(1);
  expect(runs[0].properties).toMatchObject({
    ...refusalCause,
    outcome: "success",
    finish_reason: "stop",
    model_recovery_succeeded: true,
  });
  expect(runs[0].properties).not.toHaveProperty("local_stop_reason");
  expect(Object.fromEntries(metadata)).toMatchObject({
    agentOutcome: "success",
    agentFinishReason: "stop",
    agentRecoverySucceeded: true,
  });
  expect(metadata.has("agentLocalStopReason")).toBe(false);
});

it("records every Agent retry leg before its stream state is reset", () => {
  // A new recovery entry path that resets state without recording would lose
  // the failure that started recovery (the original Max refusal defect).
  const source = fs.readFileSync(
    path.resolve(__dirname, "../agent-long.ts"),
    "utf8",
  );
  const resets = [
    ...source.matchAll(/^\s*resetAgentStreamStateForRetry\(state\);/gm),
  ].map((match) => match.index!);
  expect(resets).toHaveLength(3);
  let previous = 0;
  for (const reset of resets) {
    const window = source.slice(previous, reset);
    expect(window).toMatch(/recordModelRecovery\(/);
    previous = reset;
  }
});

it("keeps executed refusal-leg tools in the transcript without billing the refused model leg", () => {
  // Grok ran one tool, then refused the next step.
  const refusedLeg: UIMessage[] = [
    {
      id: "assistant_synthetic",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-run_terminal_cmd",
          toolCallId: "call_synthetic",
          state: "output-available",
          input: { command: "synthetic" },
          output: { result: "synthetic" },
        },
        { type: "step-start" },
        { type: "text", text: "synthetic refused text", state: "done" },
      ],
    } as UIMessage,
  ];
  const usage = new UsageTracker();
  usage.accumulateStep(
    { inputTokens: 1_000, outputTokens: 100, raw: { cost: 0.03 } },
    "model-grok-4.6",
  );
  usage.providerCost += 0.01;
  usage.nonModelCost += 0.01;

  const checkpoint = prepareProviderDisconnectContinuation(refusedLeg);
  usage.prepareModelRetry({ isLoopRecovery: false });

  // The executed tool is preserved so DeepSeek does not repeat it; the
  // refused step's text is not replayed.
  expect(checkpoint?.preservedCompletedToolCount).toBe(1);
  expect(JSON.stringify(checkpoint?.messages)).not.toContain("refused text");
  // Only tool/sandbox cost remains billable; measurement keeps the discarded
  // provider cost separately.
  expect(usage.providerCost).toBeCloseTo(0.01);
  expect(usage.measurementProperties("model-grok-4.6")).toMatchObject({
    usage_retry_resets: 1,
    usage_discarded_retry_cost_dollars: 0.03,
  });
});
