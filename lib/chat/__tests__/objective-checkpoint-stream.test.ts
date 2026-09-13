import { stepCountIs, streamText, tool, type LanguageModel } from "ai";
import { WritableStream } from "node:stream/web";
import { z } from "zod";
import { ObjectiveCheckpointRuntime } from "@/lib/ai/objective-checkpoint-runtime";
import { newObjectiveCheckpoint } from "../objective-checkpoint";

const oldWritable = Object.getOwnPropertyDescriptor(
  globalThis,
  "WritableStream",
);
beforeAll(() =>
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: WritableStream,
  }),
);
afterAll(() =>
  oldWritable
    ? Object.defineProperty(globalThis, "WritableStream", oldWritable)
    : Reflect.deleteProperty(globalThis, "WritableStream"),
);

it("uses real SDK tool steps to return a checkpoint after varied failures inside the original step budget", async () => {
  const state = newObjectiveCheckpoint("run");
  const runtime = new ObjectiveCheckpointRuntime(
    state,
    async () => {},
    async () => "e2b:test",
    new AbortController().signal,
  );
  const execute = jest.fn(async () => ({
    result: { error: "Access unavailable", exitCode: 1 },
  }));
  const tools = runtime.wrap({
    run_terminal_cmd: tool({
      inputSchema: z.object({ command: z.string() }),
      execute,
    }),
  });
  const call = (id: string, toolName: string, input: unknown) => ({
    type: "tool-call",
    toolCallId: id,
    toolName,
    input: JSON.stringify(input),
  });
  const assessment = (id: string) => ({
    action_id: id,
    outcome: "unsuccessful",
    observation: "No access to the requested workspace",
    blocker: "Workspace access is unavailable",
    artifact_refs: [],
  });
  const script = [
    [call("a", "run_terminal_cmd", { command: "ls /work" })],
    [call("assess-a", "assess_objective_progress", assessment("a"))],
    [call("b", "run_terminal_cmd", { command: "find /work -type f" })],
    [call("assess-b", "assess_objective_progress", assessment("b"))],
    [
      { type: "text-start", id: "final" },
      {
        type: "text-delta",
        id: "final",
        delta:
          "Partial work preserved. Blocker: workspace access is unavailable.",
      },
      { type: "text-end", id: "final" },
    ],
  ];
  let step = 0;
  const doStream = jest.fn(async () => {
    const parts = script[step++];
    return {
      stream: new ReadableStream({
        start(controller) {
          parts.forEach((part) => controller.enqueue(part));
          controller.enqueue({
            type: "finish",
            finishReason: {
              unified: step === 5 ? "stop" : "tool-calls",
              raw: "test",
            },
            usage: {
              inputTokens: {
                total: 10,
                noCache: 10,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 5, text: 5, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    };
  });
  const result = streamText({
    model: {
      specificationVersion: "v3",
      provider: "test",
      modelId: "test",
      supportedUrls: {},
      doStream,
      doGenerate: jest.fn(),
    } as LanguageModel,
    prompt:
      "Inspect the owned workspace and return useful partial work if blocked",
    tools,
    stopWhen: stepCountIs(5),
    prepareStep: ({ messages }) => {
      const restriction = runtime.restriction(tools);
      return restriction
        ? {
            activeTools: restriction.activeTools,
            messages: [
              ...messages,
              { role: "user", content: restriction.instruction },
            ],
          }
        : {};
    },
    onStepFinish: async () => runtime.recordSpend(step * 0.02),
  });
  await result.consumeStream();
  expect(await result.text).toContain("workspace access is unavailable");
  expect(execute).toHaveBeenCalledTimes(2);
  expect(doStream).toHaveBeenCalledTimes(5);
  expect(state.unsuccessfulAttempts).toBe(2);
  expect(state.spendDollars).toBe(0.1);
  expect(doStream.mock.calls.at(-1)).toBeDefined();
});
