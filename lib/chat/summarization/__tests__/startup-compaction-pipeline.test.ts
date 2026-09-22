import { MockLanguageModelV3 } from "ai/test";
import { APICallError, type UIMessage, type UIMessageStreamWriter } from "ai";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { deserialize, serialize } from "node:v8";

// jsdom omits this Node/Web API used by the real SDK's successful result path.
const cloneDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "structuredClone",
);
Object.defineProperty(globalThis, "structuredClone", {
  configurable: true,
  value: <T>(value: T): T => deserialize(serialize(value)),
});
afterAll(() => {
  if (cloneDescriptor)
    Object.defineProperty(globalThis, "structuredClone", cloneDescriptor);
  else Reflect.deleteProperty(globalThis, "structuredClone");
});

const models = new Map<string, MockLanguageModelV3>();
const saveSummary = jest.fn(async (_args: unknown) => undefined);
jest.doMock("server-only", () => ({}));
jest.doMock("@/lib/db/actions", () => ({
  saveChatSummary: saveSummary,
  attachChatSummaryTranscript: async () => true,
}));
jest.doMock("@/lib/ai/providers", () => ({
  KIMI_K3_SLUG: "synthetic-fallback",
  myProvider: { languageModel: (name: string) => models.get(name) },
}));
const { checkAndSummarizeIfNeeded } =
  require("../index") as typeof import("../index");
const { STARTUP_COMPACTION_ATTEMPT_TIMEOUT_MS } =
  require("../startup-compaction") as typeof import("../startup-compaction");

const summary = () => ({
  content: [
    {
      type: "text" as const,
      text: "Synthetic complete checkpoint: pending check C; no network access.",
    },
  ],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: {
    inputTokens: {
      total: 100,
      noCache: 100,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 20, text: 20, reasoning: undefined },
  },
  warnings: [],
});
const messages: UIMessage[] = Array.from({ length: 6 }, (_, index) => ({
  id: `synthetic-${index}`,
  role: index % 2 ? "assistant" : "user",
  parts: [
    {
      type: "text",
      text: `Synthetic state ${index}: pending check C; no network access.`,
    },
  ],
}));

describe("startup compaction through the real AI SDK", () => {
  let primary: MockLanguageModelV3;
  let fallback: MockLanguageModelV3;
  let finalFallback: MockLanguageModelV3;
  let writer: UIMessageStreamWriter;
  const start = (signal?: AbortSignal) =>
    checkAndSummarizeIfNeeded({
      uiMessages: messages,
      subscription: "pro",
      languageModel: primary,
      mode: "agent",
      writer,
      chatId: "synthetic-sdk-acceptance",
      abortSignal: signal,
      startupCompaction: {},
      providerPromptPressure: {
        reason: "message_count",
        reasons: ["message_count"],
        toolResultCount: 0,
        messageCount: 120,
        summarizationMaxTokensOverride: 128_000,
      },
    });

  beforeEach(() => {
    saveSummary.mockClear();
    primary = new MockLanguageModelV3({
      modelId: "synthetic-primary",
      doGenerate: async () => summary(),
    });
    fallback = new MockLanguageModelV3({
      modelId: "synthetic-fallback",
      doGenerate: async () => summary(),
    });
    finalFallback = new MockLanguageModelV3({
      modelId: "synthetic-final-fallback",
      doGenerate: async () => summary(),
    });
    models.set("model-glm-5.3-flash", primary);
    models.set("model-deepseek-v4-flash-vision-pro", fallback);
    models.set("model-glm-5.3", finalFallback);
    writer = { write: jest.fn() } as unknown as UIMessageStreamWriter;
  });

  it("aborts a stalled primary at the real deadline and persists one fallback", async () => {
    let primarySignal: AbortSignal | undefined;
    primary.doGenerate = async ({ abortSignal }) => {
      primarySignal = abortSignal;
      return new Promise((_resolve, reject) => {
        abortSignal?.addEventListener(
          "abort",
          () => reject(abortSignal.reason),
          { once: true },
        );
      });
    };
    const started = Date.now();
    const result = await start();
    expect(Date.now() - started).toBeGreaterThanOrEqual(
      STARTUP_COMPACTION_ATTEMPT_TIMEOUT_MS - 100,
    );
    expect(primarySignal?.aborted).toBe(true);
    expect(result.needsSummarization).toBe(true);
    expect(fallback.doGenerateCalls).toHaveLength(1);
    expect(saveSummary).toHaveBeenCalledTimes(1);
  }, 40_000);

  it.each(["primary", "fallback"] as const)(
    "cancels during active %s generation without persisting",
    async (attempt) => {
      const controller = new AbortController();
      let entered!: () => void;
      const active = new Promise<void>((resolve) => {
        entered = resolve;
      });
      if (attempt === "fallback") {
        primary.doGenerate = async () => {
          throw new APICallError({
            message: "Synthetic 429",
            url: "https://synthetic.invalid",
            requestBodyValues: {},
            statusCode: 429,
            isRetryable: true,
          });
        };
      }
      const target = attempt === "primary" ? primary : fallback;
      target.doGenerate = async ({ abortSignal }) => {
        entered();
        return new Promise((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true },
          );
        });
      };
      const result = start(controller.signal);
      const rejected = expect(result).rejects.toMatchObject({
        name: "AbortError",
      });
      await active;
      controller.abort();
      await rejected;
      expect(saveSummary).not.toHaveBeenCalled();
      if (attempt === "primary")
        expect(fallback.doGenerateCalls).toHaveLength(0);
      expect(writer.write).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: "data-summarization",
          data: expect.objectContaining({ status: "completed" }),
        }),
      );
    },
  );
});
