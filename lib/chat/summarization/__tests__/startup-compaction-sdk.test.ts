import { MockLanguageModelV3 } from "ai/test";
import { APICallError } from "ai";
import { generateSummaryText } from "../helpers";
import { isRecoverableStartupCompactionError } from "../startup-compaction";

jest.mock("@/lib/db/actions", () => ({}));

const generate = (model: MockLanguageModelV3, signal?: AbortSignal) =>
  generateSummaryText(
    [
      {
        id: "source",
        role: "user",
        parts: [
          {
            type: "text",
            text: "Preserve the running session; do not restart it.",
          },
        ],
      },
    ],
    model,
    "agent",
    "Summarize the supplied context.",
    false,
    undefined,
    undefined,
    signal,
    undefined,
    1000,
    { maxRetries: 0 },
  );

describe("startup compaction SDK boundary", () => {
  it("passes user cancellation into the provider", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV3({
      doGenerate: ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true },
          );
          controller.abort(new Error("user stopped"));
        }),
    });
    await expect(generate(model, controller.signal)).rejects.toThrow(
      "user stopped",
    );
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("does not spend automatic retries on a rate-limited primary", async () => {
    const error = new APICallError({
      message: "rate limited",
      url: "https://example.test",
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: true,
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw error;
      },
    });
    await expect(generate(model)).rejects.toThrow("rate limited");
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(isRecoverableStartupCompactionError(error)).toBe(true);
  });

  it("still classifies provider timeouts as recoverable", () => {
    expect(
      isRecoverableStartupCompactionError(
        Object.assign(new Error("provider timeout"), { name: "TimeoutError" }),
      ),
    ).toBe(true);
  });
});
