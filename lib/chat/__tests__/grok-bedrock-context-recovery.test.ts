/**
 * @jest-environment node
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { withOpenRouterStreamErrorContext } from "@/lib/ai/openrouter-stream-error-context";
import { GROK_4_6_BEDROCK_MODEL_KEY } from "@/lib/ai/grok-bedrock";
import {
  DEEPSEEK_1017_MODEL_KEY,
  DEEPSEEK_1017_SLUG,
} from "@/lib/experiments/paid-deepseek-1017";
import { classifyProviderOverflowError } from "@/lib/utils/error-utils";
import { getSameCallGrokBedrockPromptContextLimit } from "@/lib/utils/openrouter-stream-error-context";
import {
  getNextProviderDisconnectRetryModel,
  prepareGrokBedrockContextRecovery,
  PROVIDER_DISCONNECT_CONTINUATION_PROMPT,
} from "../agent-long-provider-retry";

// The normalized template recorded on production Trigger spans.
const GROK_CONTEXT_REJECTION = {
  code: 400,
  message:
    "prompt tokens (741262) exceed model maximum (524288) for xai.grok-4.6",
};
// DeepSeek 1017's Max compaction threshold: 508,288 budget - 20,000 reserve.
const DEEPSEEK_THRESHOLD = 488_288;

const sse = (...events: unknown[]) =>
  new Response(
    [...events.map((event) => `data: ${JSON.stringify(event)}`), "[DONE]"]
      .map((line) => (line === "[DONE]" ? `data: [DONE]\n\n` : `${line}\n\n`))
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const toolCallTurn = () =>
  sse(
    {
      id: "gen-tool",
      model: "x-ai/grok-4.6",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_probe",
                type: "function",
                function: { name: "probe", arguments: '{"target":"a"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "gen-tool",
      model: "x-ai/grok-4.6",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  );

/**
 * One Max Grok-on-Bedrock leg through the actual OpenRouter SDK and the
 * production wrapper options: a real tool executes in step one, then the
 * already-open step-two stream carries the provider's in-band rejection.
 */
async function runGrokLeg({
  rejection = GROK_CONTEXT_REJECTION as Record<string, unknown>,
  bedrock = true,
}: { rejection?: Record<string, unknown>; bedrock?: boolean } = {}) {
  const fetch = jest
    .fn()
    .mockResolvedValueOnce(toolCallTurn())
    .mockResolvedValueOnce(sse({ error: rejection }));
  const executions: unknown[] = [];
  const tools = {
    probe: tool({
      inputSchema: z.object({ target: z.string() }),
      execute: async (input) => {
        executions.push(input);
        return { observed: `result for ${input.target}` };
      },
    }),
  };
  const errors: unknown[] = [];
  const result = streamText({
    model: withOpenRouterStreamErrorContext(
      createOpenRouter({ apiKey: "synthetic-unused", fetch }).chat(
        "x-ai/grok-4.6",
      ),
      bedrock
        ? {
            bedrockToolPairingDiagnostic: true,
            bedrockStreamRejectionDiagnostic: true,
          }
        : {},
    ),
    messages: [{ role: "user", content: "synthetic task" }],
    tools,
    stopWhen: stepCountIs(5),
    maxRetries: 0,
    onError: ({ error }) => {
      errors.push(error);
    },
  });
  let finished: UIMessage[] = [];
  const stream = result.toUIMessageStream({
    onFinish: ({ messages }) => {
      finished = messages;
    },
  });
  for await (const _ of stream) {
    // Drain so onFinish observes the persisted response shape.
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(errors).toHaveLength(1);
  return { providerError: errors[0], messages: finished, executions, tools };
}

const recover = (
  overrides: Partial<Parameters<typeof prepareGrokBedrockContextRecovery>[0]>,
) => {
  const estimate = jest.fn(async () => 120_000);
  return {
    estimate,
    result: prepareGrokBedrockContextRecovery({
      rejection: { promptTokens: 741_262, maxTokens: 524_288 },
      mode: "agent",
      selectedModelOverride: "hackerai-max",
      activeModelName: GROK_4_6_BEDROCK_MODEL_KEY,
      cancelled: false,
      alreadyRetried: false,
      competingRecovery: false,
      messages: [],
      buildRecoveryMessages: (messages) => messages,
      estimateRequiredContextTokens: estimate,
      agentModelContextEnabled: true,
      subscription: "ultra",
      ...overrides,
    }),
  };
};

const assistant = (parts: UIMessage["parts"]): UIMessage[] => [
  { id: "assistant", role: "assistant", parts },
];
const completedTool = {
  type: "tool-probe",
  toolCallId: "call_done",
  state: "output-available",
  input: { target: "a" },
  output: { observed: "done" },
} as UIMessage["parts"][number];

it("continues a Grok Bedrock prompt rejection once on DeepSeek from the saved tool result", async () => {
  const leg = await runGrokLeg();
  // The global overflow classifier already matches this text; on its own it
  // only marks token exhaustion and cannot replay the opened stream.
  expect(classifyProviderOverflowError(leg.providerError)).toBe("context");
  const rejection = getSameCallGrokBedrockPromptContextLimit(leg.providerError);
  expect(rejection).toEqual({ promptTokens: 741_262, maxTokens: 524_288 });

  const sized: UIMessage[][] = [];
  const recovery = await prepareGrokBedrockContextRecovery({
    rejection,
    mode: "agent",
    selectedModelOverride: "hackerai-max",
    activeModelName: GROK_4_6_BEDROCK_MODEL_KEY,
    cancelled: false,
    alreadyRetried: false,
    competingRecovery: false,
    messages: leg.messages,
    buildRecoveryMessages: (messages) => [
      ...messages,
      {
        id: "prompt",
        role: "user",
        parts: [
          { type: "text", text: PROVIDER_DISCONNECT_CONTINUATION_PROMPT },
        ],
      },
    ],
    estimateRequiredContextTokens: async (messages) => {
      sized.push(messages);
      return DEEPSEEK_THRESHOLD;
    },
    agentModelContextEnabled: true,
    subscription: "ultra",
  });
  if (recovery?.reason !== "eligible")
    throw new Error("Expected the Grok context recovery to be eligible");
  const checkpoint = recovery.continuation;
  expect(checkpoint.preservedCompletedToolCount).toBe(1);
  const saved = checkpoint.messages
    .at(-1)!
    .parts.find((part) => part.type === "tool-probe");
  expect(saved).toMatchObject({
    toolCallId: "call_probe",
    state: "output-available",
    output: { observed: "result for a" },
  });
  // The size gate saw the continuation exactly as it will be sent.
  expect(sized).toHaveLength(1);
  expect(recovery.messages).toBe(sized[0]);
  expect(recovery.messages.at(-1)?.parts).toEqual([
    { type: "text", text: PROVIDER_DISCONNECT_CONTINUATION_PROMPT },
  ]);

  // DeepSeek receives the completed result and finishes without the tool
  // running again.
  const deepseekFetch = jest.fn().mockResolvedValueOnce(
    sse(
      {
        id: "gen-recovery",
        model: DEEPSEEK_1017_SLUG,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Finished from the result." },
            finish_reason: null,
          },
        ],
      },
      {
        id: "gen-recovery",
        model: DEEPSEEK_1017_SLUG,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
      },
    ),
  );
  const continued = streamText({
    model: withOpenRouterStreamErrorContext(
      createOpenRouter({
        apiKey: "synthetic-unused",
        fetch: deepseekFetch,
      }).chat(DEEPSEEK_1017_SLUG),
    ),
    messages: await convertToModelMessages(recovery.messages, {
      tools: leg.tools,
    }),
    tools: leg.tools,
    stopWhen: stepCountIs(5),
    maxRetries: 0,
  });
  expect(await continued.text).toBe("Finished from the result.");
  expect(leg.executions).toHaveLength(1);
  const body = JSON.parse(deepseekFetch.mock.calls[0][1].body);
  expect(body.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_probe",
        content: expect.stringContaining("result for a"),
      }),
    ]),
  );

  // That DeepSeek attempt is the only one: a later disconnect is terminal,
  // although the same failure after an ordinary first recovery would retry.
  const nextAttempt = {
    originalModel: GROK_4_6_BEDROCK_MODEL_KEY,
    failedModel: DEEPSEEK_1017_MODEL_KEY,
    completedRetryCount: 1,
    selectedModelOverride: "hackerai-max",
    agentModelContextEnabled: true,
    subscription: "ultra" as const,
    requiredContextTokens: 10_000,
  };
  expect(getNextProviderDisconnectRetryModel(nextAttempt)).toBe(
    DEEPSEEK_1017_MODEL_KEY,
  );
  expect(
    getNextProviderDisconnectRetryModel({
      ...nextAttempt,
      afterPromptContextRecovery: true,
    }),
  ).toBeUndefined();
});

it.each([
  ["a non-Bedrock route", { bedrock: false }],
  [
    "a different status",
    { rejection: { ...GROK_CONTEXT_REJECTION, code: 413 } },
  ],
  [
    "the hyphenated router slug",
    {
      rejection: {
        ...GROK_CONTEXT_REJECTION,
        message:
          "prompt tokens (741262) exceed model maximum (524288) for x-ai.grok-4.6",
      },
    },
  ],
  [
    "another model",
    {
      rejection: {
        ...GROK_CONTEXT_REJECTION,
        message:
          "prompt tokens (741262) exceed model maximum (524288) for xai.grok-4.5",
      },
    },
  ],
  [
    "extra text around the template",
    {
      rejection: {
        ...GROK_CONTEXT_REJECTION,
        message: `[Amazon Bedrock] ${GROK_CONTEXT_REJECTION.message}`,
      },
    },
  ],
  [
    "a count within the maximum",
    {
      rejection: {
        ...GROK_CONTEXT_REJECTION,
        message:
          "prompt tokens (524288) exceed model maximum (524288) for xai.grok-4.6",
      },
    },
  ],
  [
    "a generic context-length 400",
    {
      rejection: {
        code: 400,
        message: "context_length_exceeded",
        metadata: { raw: "maximum context length exceeded" },
      },
    },
  ],
  [
    "an image retrieval rejection",
    {
      rejection: {
        code: 400,
        message: "invalid_request",
        param: "messages[3].content[1].image_url",
        metadata: { raw: "Failed to fetch image" },
      },
    },
  ],
])("does not classify %s as the Grok context rejection", async (_, input) => {
  const leg = await runGrokLeg(input);
  expect(
    getSameCallGrokBedrockPromptContextLimit(leg.providerError),
  ).toBeUndefined();
  // Without a classified rejection there is no new recovery decision.
  expect(
    await recover({ rejection: undefined, messages: leg.messages }).result,
  ).toBeUndefined();
});

it("accepts the slash form of the same model but not a copied error", async () => {
  const leg = await runGrokLeg({
    rejection: {
      ...GROK_CONTEXT_REJECTION,
      message:
        "prompt tokens (741262) exceed model maximum (524288) for xai/grok-4.6",
    },
  });
  expect(getSameCallGrokBedrockPromptContextLimit(leg.providerError)).toEqual({
    promptTokens: 741_262,
    maxTokens: 524_288,
  });
  // An object the wrapper never observed carries no same-call evidence.
  expect(
    getSameCallGrokBedrockPromptContextLimit({ ...GROK_CONTEXT_REJECTION }),
  ).toBeUndefined();
});

it.each<
  [
    string,
    Partial<Parameters<typeof prepareGrokBedrockContextRecovery>[0]>,
    string,
  ]
>([
  [
    "a step served by another model",
    { activeModelName: "inference-cyber" },
    "not_max_bedrock_step",
  ],
  [
    "a non-Max selection",
    { selectedModelOverride: "hackerai-pro" },
    "not_max_bedrock_step",
  ],
  ["Ask mode", { mode: "ask" }, "not_max_bedrock_step"],
  ["a cancelled or resumed run", { cancelled: true }, "cancelled"],
  ["a run that already retried", { alreadyRetried: true }, "already_retried"],
  [
    "a content-filter, loop, image or vision recovery",
    { competingRecovery: true },
    "competing_recovery",
  ],
  [
    "an unpaired tool call",
    {
      messages: assistant([
        { type: "step-start" },
        completedTool,
        {
          type: "tool-probe",
          toolCallId: "call_open",
          state: "input-available",
          input: { target: "b" },
        } as UIMessage["parts"][number],
        { type: "step-start" },
      ]),
    },
    "unsafe_checkpoint",
  ],
  [
    "an approval-pending tool call",
    {
      messages: assistant([
        { type: "step-start" },
        {
          type: "tool-probe",
          toolCallId: "call_approval",
          state: "approval-requested",
          input: { target: "b" },
          approval: { id: "approval" },
        } as UIMessage["parts"][number],
      ]),
    },
    "unsafe_checkpoint",
  ],
  [
    "a tool with an unknown outcome",
    {
      messages: assistant([
        { type: "step-start" },
        {
          ...completedTool,
          output: { executionOutcome: "unknown" },
        } as UIMessage["parts"][number],
        { type: "step-start" },
      ]),
    },
    "unsafe_checkpoint",
  ],
  [
    "output already streamed in the rejected step",
    {
      messages: assistant([
        { type: "step-start" },
        completedTool,
        { type: "step-start" },
        { type: "text", text: "Partial answer", state: "done" },
      ]),
    },
    "unsafe_checkpoint",
  ],
  [
    "a reported prompt beyond DeepSeek's whole window",
    { rejection: { promptTokens: 3_636_972, maxTokens: 524_288 } },
    "reported_oversize",
  ],
  [
    "an unknown continuation size",
    { estimateRequiredContextTokens: async () => undefined },
    "size_unknown",
  ],
  [
    "a failed continuation serialization",
    {
      estimateRequiredContextTokens: async () => {
        throw new Error("conversion failed");
      },
    },
    "size_unknown",
  ],
  [
    "a continuation over DeepSeek's threshold",
    { estimateRequiredContextTokens: async () => DEEPSEEK_THRESHOLD + 1 },
    "oversize",
  ],
])("declines %s", async (_, overrides, reason) => {
  const { result } = recover({
    messages: assistant([{ type: "step-start" }, completedTool]),
    ...overrides,
  });
  const decision = await result;
  expect(decision).toEqual({ reason });
});

it("sizes nothing once a reported prompt cannot fit DeepSeek", async () => {
  const { result, estimate } = recover({
    rejection: { promptTokens: 1_016_577, maxTokens: 524_288 },
  });
  expect(await result).toEqual({ reason: "reported_oversize" });
  expect(estimate).not.toHaveBeenCalled();
});

it("admits an empty checkpoint only when the leg produced no assistant work", async () => {
  expect((await recover({ messages: [] }).result)?.continuation).toEqual(
    expect.objectContaining({ messages: [], preservedCompletedToolCount: 0 }),
  );
  expect(
    (await recover({ messages: assistant([{ type: "step-start" }]) }).result)
      ?.reason,
  ).toBe("eligible");
});
