/** @jest-environment node */
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn(), flush: jest.fn() },
}));
import { generateText, NoOutputGeneratedError, Output } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { phLogger } from "@/lib/posthog/server";
import { readResearchStructuredOutput } from "../structured-output-diagnostics";

const event = phLogger.event as jest.Mock;
const flush = phLogger.flush as jest.Mock;
const ctx = {
  run: { id: "run_06gt0000000000000000000000" },
  attempt: { number: 2 },
  deployment: { version: "20261114.3" },
};

const mockModel = (
  finishReason: "stop" | "length",
  text: string,
  responseId = "gen-1731600000-AbCdEf123456",
) =>
  new MockLanguageModelV3({
    doGenerate: {
      content: text ? [{ type: "text", text }] : [],
      finishReason: { unified: finishReason, raw: finishReason },
      usage: {
        inputTokens: {
          total: 4_200,
          noCache: 4_200,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 6_000, text: 0, reasoning: 6_000 },
      },
      warnings: [],
      response: {
        id: responseId,
        modelId: "synthetic",
        timestamp: new Date(0),
      },
    },
  });

const generate = (model: MockLanguageModelV3) =>
  generateText({
    model,
    output: Output.object({ schema: z.object({ summary: z.string() }) }),
    maxRetries: 1,
    prompt: "Synthetic prompt",
  });

const resultWithOutputError = (error: unknown, fields: object = {}) => ({
  get output(): never {
    throw error;
  },
  finishReason: "length",
  usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  response: { id: "gen-synthetic" },
  ...fields,
});

beforeEach(() => {
  jest.clearAllMocks();
  event.mockReset();
  flush.mockReset().mockResolvedValue(undefined);
});

it("reports the finish reason and usage when the real SDK getter has no output", async () => {
  const model = mockModel("length", "");
  const result = await generate(model);

  const read = readResearchStructuredOutput(result, {
    operation: "profile",
    ctx,
  });

  await expect(read).rejects.toThrow(NoOutputGeneratedError);
  await expect(read).rejects.toThrow("No output generated.");
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(event).toHaveBeenCalledTimes(1);
  expect(event).toHaveBeenCalledWith("user_research_structured_output_failed", {
    diagnostic_version: 1,
    operation: "profile",
    finish_reason: "length",
    input_tokens: 4_200,
    output_tokens: 6_000,
    total_tokens: 10_200,
    reasoning_tokens: 6_000,
    configured_model_key: "model-grok-4.6",
    openrouter_generation_id: "gen-1731600000-AbCdEf123456",
    trigger_run_id: "run_06gt0000000000000000000000",
    trigger_attempt_number: 2,
    trigger_deployment_version: "20261114.3",
  });
  expect(flush).toHaveBeenCalledTimes(1);
});

it("returns healthy output without publishing or flushing", async () => {
  const result = await generate(mockModel("stop", '{"summary":"ok"}'));

  await expect(
    readResearchStructuredOutput(result, { operation: "synthesis", ctx }),
  ).resolves.toEqual({ summary: "ok" });
  expect(event).not.toHaveBeenCalled();
  expect(flush).not.toHaveBeenCalled();
});

it.each([
  new Error("No output generated."),
  Object.assign(new Error("No output generated."), {
    name: "AI_NoOutputGeneratedError",
  }),
  "not an error",
])(
  "does not report other output getter failures: %p",
  async (thrown: unknown) => {
    await expect(
      readResearchStructuredOutput(resultWithOutputError(thrown), {
        operation: "profile",
        ctx,
      }),
    ).rejects.toBe(thrown);
    expect(event).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  },
);

it("preserves an original rejection whose SDK marker check throws", async () => {
  const original = new Proxy(new Error("synthetic rejection"), {
    has() {
      throw new Error("marker unavailable");
    },
  });
  await expect(
    readResearchStructuredOutput(resultWithOutputError(original), {
      operation: "profile",
      ctx,
    }),
  ).rejects.toBe(original);
  expect(event).not.toHaveBeenCalled();
});

it.each(["gen-private-research-label", "gen-1731600000-AbCdEf123456\n"])(
  "omits a generation identifier outside the public format: %p",
  async (id) => {
    await expect(
      readResearchStructuredOutput(
        resultWithOutputError(new NoOutputGeneratedError(), {
          response: { id },
        }),
        { operation: "profile", ctx },
      ),
    ).rejects.toThrow(NoOutputGeneratedError);
    expect(event.mock.calls[0][1]).not.toHaveProperty(
      "openrouter_generation_id",
    );
  },
);

it("rethrows the identical error when publishing, flushing, or metadata reads fail", async () => {
  const original = new NoOutputGeneratedError();
  event.mockImplementation(() => {
    throw new Error("capture failed");
  });
  await expect(
    readResearchStructuredOutput(resultWithOutputError(original), {
      operation: "profile",
      ctx,
    }),
  ).rejects.toBe(original);

  event.mockReset();
  flush.mockImplementation(() => {
    throw new Error("flush threw synchronously");
  });
  await expect(
    readResearchStructuredOutput(resultWithOutputError(original), {
      operation: "profile",
      ctx,
    }),
  ).rejects.toBe(original);

  flush.mockRejectedValue(new Error("flush rejected"));
  const throwingMetadata = {
    get output(): never {
      throw original;
    },
    get finishReason(): never {
      throw new Error("finish reason unavailable");
    },
    get usage(): never {
      throw new Error("usage unavailable");
    },
    get response(): never {
      throw new Error("response unavailable");
    },
  };
  await expect(
    readResearchStructuredOutput(throwingMetadata, {
      operation: "synthesis",
      ctx: {
        run: { id: "run_06gt0000000000000000000002" },
        get attempt(): never {
          throw new Error("attempt unavailable");
        },
      },
    }),
  ).rejects.toBe(original);
  expect(event).toHaveBeenCalledWith("user_research_structured_output_failed", {
    diagnostic_version: 1,
    operation: "synthesis",
    finish_reason: "unavailable",
    configured_model_key: "model-grok-4.6",
    trigger_run_id: "run_06gt0000000000000000000002",
  });
});

it("omits metadata that fails validation instead of forwarding it", async () => {
  const original = new NoOutputGeneratedError();
  await expect(
    readResearchStructuredOutput(
      resultWithOutputError(original, {
        finishReason: "length; prompt=secret",
        usage: {
          inputTokens: -1,
          outputTokens: 1.5,
          totalTokens: 10_000_001,
          outputTokenDetails: { reasoningTokens: "6000" },
          raw: { prompt: "private" },
        },
        response: {
          id: "gen-abc def",
          headers: { authorization: "Bearer secret" },
          body: { choices: [{ message: { content: "private" } }] },
        },
        text: "private generated text",
        providerMetadata: { openrouter: { provider: "x" } },
      }),
      {
        operation: "profile",
        ctx: {
          run: { id: "user-1" },
          attempt: { number: 0 },
          deployment: { version: "user@example.com" },
        },
      },
    ),
  ).rejects.toBe(original);

  const [name, fields, ...rest] = event.mock.calls[0];
  expect(name).toBe("user_research_structured_output_failed");
  expect(rest).toEqual([]);
  expect(fields).toEqual({
    diagnostic_version: 1,
    operation: "profile",
    finish_reason: "unavailable",
    configured_model_key: "model-grok-4.6",
  });
  expect(JSON.stringify(fields)).not.toMatch(/private|secret|user/);
});

describe("bounded flush", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("rethrows after one second when flushing never settles and leaves no timer", async () => {
    flush.mockReturnValue(new Promise(() => {}));
    const original = new NoOutputGeneratedError();
    const settled = jest.fn();
    const read = readResearchStructuredOutput(resultWithOutputError(original), {
      operation: "profile",
      ctx,
    }).catch((error) => {
      settled(error);
    });

    await jest.advanceTimersByTimeAsync(999);
    expect(settled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await read;
    expect(settled).toHaveBeenCalledWith(original);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("handles a flush rejection that arrives after the timeout", async () => {
    let rejectFlush!: (error: Error) => void;
    flush.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectFlush = reject;
      }),
    );
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const original = new NoOutputGeneratedError();
      const read = readResearchStructuredOutput(
        resultWithOutputError(original),
        { operation: "synthesis", ctx },
      );
      const assertion = expect(read).rejects.toBe(original);
      await jest.advanceTimersByTimeAsync(1_000);
      await assertion;

      rejectFlush(new Error("late flush failure"));
      jest.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("returns as soon as the flush completes", async () => {
    const original = new NoOutputGeneratedError();
    await expect(
      readResearchStructuredOutput(resultWithOutputError(original), {
        operation: "profile",
        ctx,
      }),
    ).rejects.toBe(original);
    expect(jest.getTimerCount()).toBe(0);
  });
});
