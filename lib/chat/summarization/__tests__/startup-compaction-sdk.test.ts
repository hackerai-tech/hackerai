import { MockLanguageModelV3 } from "ai/test";
import { APICallError } from "ai";
import { generateSummaryText } from "../helpers";
import {
  getStartupCompactionVariant,
  isRecoverableStartupCompactionError,
} from "../startup-compaction";
import { getPostHogFeatureFlagVariantForUser } from "@/lib/posthog/server";

jest.mock("@/lib/db/actions", () => ({}));
jest.mock("@/lib/posthog/server", () => ({
  getPostHogFeatureFlagVariantForUser: jest.fn(),
}));

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
    { timeout: 30, maxRetries: 0, requireCompleteSummary: true },
  );

describe("startup compaction SDK boundary", () => {
  it("aborts the actual provider operation at the deadline without retrying", async () => {
    let providerSignal: AbortSignal | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: ({ abortSignal }) => {
        providerSignal = abortSignal;
        return new Promise((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true },
          );
        });
      },
    });
    let failure: unknown;
    try {
      await generate(model);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(providerSignal?.aborted).toBe(true);
    expect(isRecoverableStartupCompactionError(failure)).toBe(true);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("passes cancellation into the provider independently of the deadline", async () => {
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

  it.each([undefined, "control", "unknown"])(
    "defaults an unrecognized assignment to control: %s",
    async (value) => {
      jest.mocked(getPostHogFeatureFlagVariantForUser).mockResolvedValue(value);
      await expect(getStartupCompactionVariant("user-test")).resolves.toBe(
        "control",
      );
      expect(getPostHogFeatureFlagVariantForUser).toHaveBeenCalledWith(
        "agent_startup_compaction_v1",
        "user-test",
        { sendFeatureFlagEvents: false },
      );
    },
  );

  it("does not evaluate a missing identity", async () => {
    await expect(getStartupCompactionVariant("")).resolves.toBe("control");
    expect(getPostHogFeatureFlagVariantForUser).not.toHaveBeenCalled();
  });
});
