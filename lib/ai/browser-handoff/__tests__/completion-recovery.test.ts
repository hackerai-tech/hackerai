import { streamText, stepCountIs, tool, type LanguageModel } from "ai";
import { WritableStream } from "node:stream/web";
import { z } from "zod";
import { recoverBrowserHandoffCompletion } from "../completion-recovery";

const originalWritableStream = globalThis.WritableStream;
beforeAll(() => {
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: WritableStream,
  });
});
afterAll(() => {
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: originalWritableStream,
  });
});

const finish = (reason = "stop") => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
});
const response = (text: string, extra: unknown[] = [], reason = "stop") => ({
  stream: new ReadableStream({
    start(controller) {
      [
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: text },
        { type: "text-end", id: "text" },
        ...extra,
        finish(reason),
      ].forEach((part) => controller.enqueue(part));
      controller.close();
    },
  }),
});
const model = (doStream: jest.Mock): LanguageModel => ({
  specificationVersion: "v3",
  provider: "test",
  modelId: "auto-test",
  supportedUrls: {},
  doGenerate: jest.fn(),
  doStream,
});
const request = "Open the browser and wait for me to take control.";
const promise =
  "Handing control over now. Take control in the browser sidebar.";

const params = (text = request, overrides = {}) => ({
  prompt: [{ role: "user", content: [{ type: "text", text }] }],
  tools: [{ type: "function", name: "browser_handoff", inputSchema: {} }],
  ...overrides,
});
async function parts(
  text = promise,
  {
    input = params(),
    extra = [] as unknown[],
    reason = "stop",
    state = {} as { attempted?: boolean },
    canRecover = jest.fn(async () => true),
  } = {},
) {
  const wrapped = recoverBrowserHandoffCompletion(
    model(jest.fn(async () => response(text, extra, reason))),
    { state, canRecover },
  );
  if (typeof wrapped === "string") throw Error("Expected model");
  const result = await wrapped.doStream(input as never);
  const output = [];
  for await (const part of result.stream) output.push(part);
  return { output, canRecover, state };
}

it("executes the real wait before Auto can finish, then continues with its result", async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  const execute = jest.fn(async () => {
    entered();
    await new Promise<void>((resolve) => (release = resolve));
    return { status: "resumed", message: "Take a fresh snapshot first." };
  });
  const calls = jest
    .fn()
    .mockResolvedValueOnce(response(promise))
    .mockResolvedValueOnce(
      response("I inspected the current page after resume."),
    );
  const result = streamText({
    model: recoverBrowserHandoffCompletion(model(calls), {
      state: {},
      canRecover: async () => true,
    }),
    prompt: request,
    tools: { browser_handoff: tool({ inputSchema: z.object({}), execute }) },
    stopWhen: stepCountIs(3),
  });
  let completed = false;
  const consumed = result.consumeStream().then(() => (completed = true));
  // Race an observable tool entry against premature completion; no timer needed.
  await Promise.race([waiting, consumed]);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(completed).toBe(false);
  expect(calls).toHaveBeenCalledTimes(1);
  release();
  await consumed;
  expect(calls).toHaveBeenCalledTimes(2);
  expect(calls.mock.calls[1][0].prompt).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        content: expect.arrayContaining([
          expect.objectContaining({ toolName: "browser_handoff" }),
        ]),
      }),
    ]),
  );
});

it.each([
  "HANDING CONTROL OVER NOW! TAKE CONTROL IN THE SIDEBAR.",
  "The page is open. **Handing control to you now** — use Take control.",
  "The page is open.\nHanding browser control over to you right now: click Take control.",
  "I'll wait for you to take control. Choose Send and continue when done.",
  "I’ll wait for you to take control. Choose Send and continue when done.",
  "I'm pausing now and waiting for you to take control.",
  "The browser is now ready for you to take control.",
  "I'll wait for you to take control now.",
  "I'll wait for you to take control in the browser sidebar.",
  "I'll wait for you to take control, then I'll continue after you resume.",
  "The browser is ready for you to take control right now.",
])(
  "recovers an immediate declaration with case and punctuation: %s",
  async (text) => {
    const { output, state } = await parts(text, {
      input: params("Don't click the CAPTCHA. WAIT for me to TAKE CONTROL!"),
    });
    expect(output).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        toolName: "browser_handoff",
        input: "{}",
      }),
    );
    expect(state.attempted).toBe(true);
    expect(output.at(-1)).toMatchObject({
      finishReason: { unified: "tool-calls" },
    });
  },
);

it("recovers a declaration after a fenced block longer than the prose window", async () => {
  const { output } = await parts(
    "```text\n" + "x".repeat(5000) + "\n```\n" + promise,
  );
  expect(output).toContainEqual(
    expect.objectContaining({ type: "tool-call", toolName: "browser_handoff" }),
  );
});

it("preserves fence state across stream chunks and excludes long unclosed code", async () => {
  const deltas = [
    "``",
    "`text\n",
    "x".repeat(5000),
    "\n`",
    "`",
    "`\n",
    promise,
  ];
  const doStream = jest.fn(async () => ({
    stream: new ReadableStream({
      start(controller) {
        for (const delta of deltas)
          controller.enqueue({ type: "text-delta", id: "text", delta });
        controller.enqueue(finish());
        controller.close();
      },
    }),
  }));
  const wrapped = recoverBrowserHandoffCompletion(model(doStream), {
    state: {},
    canRecover: async () => true,
  });
  if (typeof wrapped === "string") throw Error("Expected model");
  const result = await wrapped.doStream(params() as never);
  const output = [];
  for await (const part of result.stream) output.push(part);
  expect(output).toContainEqual(
    expect.objectContaining({ type: "tool-call", toolName: "browser_handoff" }),
  );
  const unclosed = await parts("```text\n" + "x".repeat(5000) + "\n" + promise);
  expect(unclosed.canRecover).not.toHaveBeenCalled();
});

it.each([
  "You can take control when you're ready.",
  "After setup, I'll be handing control over to you.",
  "I'll wait for you to take control after setup.",
  "I am not handing control over now.",
  "I'll wait for you to take control, but not until after I finish setup.",
  "I'll wait for you to take control, after setup.",
  "The browser is ready for you to take control after setup.",
  "The browser is ready for you to take control, once setup finishes.",
  "> Handing control over now. Take control in the sidebar.",
  "```text\nHanding control over now.\n```",
  "```text\nHanding control over now.",
  'The phrase "Handing control over now" describes the button.',
])(
  "leaves informational, future, negated and quoted text alone: %s",
  async (text) => {
    const { output, canRecover } = await parts(text);
    expect(output.some((part) => part.type === "tool-call")).toBe(false);
    expect(canRecover).not.toHaveBeenCalled();
  },
);

it.each([
  "Explain how the browser works.",
  "Do not wait for me to take control.",
  "Don’t wait for me to take control.",
  "Don't call browser_handoff. Just describe it.",
  "I don't want to take control.",
  'Explain the text "take control".',
  "Explain this code:\n```\nbrowser_handoff\n```",
])("requires a current affirmative user request: %s", async (text) => {
  const { output, canRecover } = await parts(promise, { input: params(text) });
  expect(output.some((part) => part.type === "tool-call")).toBe(false);
  expect(canRecover).not.toHaveBeenCalled();
});

it.each(["length", "error", "content-filter"])(
  "does not repair %s finishes",
  async (reason) => {
    const { output, canRecover } = await parts(promise, { reason });
    expect(output.some((part) => part.type === "tool-call")).toBe(false);
    expect(canRecover).not.toHaveBeenCalled();
  },
);

it.each([
  {
    type: "tool-call",
    toolCallId: "real",
    toolName: "browser_handoff",
    input: "{}",
  },
  { type: "tool-input-start", id: "partial", toolName: "browser_handoff" },
  { type: "tool-input-delta", id: "partial", delta: "{" },
  { type: "error", error: new Error("provider failed") },
])("does not duplicate or replay a tool/error output: $type", async (part) => {
  const { output, canRecover } = await parts(promise, { extra: [part] });
  expect(output.filter((p) => p.type === "tool-call")).toHaveLength(
    part.type === "tool-call" ? 1 : 0,
  );
  expect(canRecover).not.toHaveBeenCalled();
});

it("does not wait again after a handoff call already returned", async () => {
  const input = params();
  input.prompt.push({
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolName: "browser_handoff",
        toolCallId: "done",
        input: {},
      },
    ],
  } as never);
  const { output, canRecover } = await parts(promise, { input });
  expect(output.some((part) => part.type === "tool-call")).toBe(false);
  expect(canRecover).not.toHaveBeenCalled();
});

it.each([
  { tools: [] },
  { toolChoice: { type: "none" } },
  { toolChoice: { type: "tool", toolName: "wait_for_agents" } },
])("respects the current tool permissions: %j", async (overrides) => {
  const { output, canRecover } = await parts(promise, {
    input: params(request, overrides),
  });
  expect(output.some((part) => part.type === "tool-call")).toBe(false);
  expect(canRecover).not.toHaveBeenCalled();
});

it("skips an unavailable browser and bounds recovery across provider retries", async () => {
  const canRecover = jest.fn(async () => false);
  const unavailable = await parts(promise, { canRecover });
  expect(unavailable.output.some((part) => part.type === "tool-call")).toBe(
    false,
  );
  const state = {};
  await parts(promise, { state });
  const retry = await parts(promise, { state });
  expect(retry.output.some((part) => part.type === "tool-call")).toBe(false);
  expect(retry.canRecover).not.toHaveBeenCalled();
});

it("never enters the wait if Stop wins the live-browser probe", async () => {
  const stop = new AbortController();
  const { output, state } = await parts(promise, {
    input: params(request, { abortSignal: stop.signal }),
    canRecover: jest.fn(async () => {
      stop.abort();
      return true;
    }),
  });
  expect(output.some((part) => part.type === "tool-call")).toBe(false);
  expect(state.attempted).not.toBe(true);
});
