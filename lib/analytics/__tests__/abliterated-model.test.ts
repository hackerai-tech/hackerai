import type { LanguageModel } from "ai";
import { AbliteratedModelTelemetry } from "../abliterated-model";
import { guardLanguageModelProviderResponse } from "@/lib/ai/provider-response-guard";
import { ABLITERATED_EXPERIMENT_KEY } from "@/lib/experiments/abliterated-model";
import { FREE_ASK_ABLITERATED_EXPERIMENT_KEY } from "@/lib/experiments/abliteration-keys";

const finishPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 10, cacheRead: 2 },
    outputTokens: { total: 5, reasoning: 1 },
  },
};
function model(
  parts: unknown[],
  fails = false,
  modelId = "abliterated-model",
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId,
    supportedUrls: {},
    doGenerate: jest.fn(),
    doStream: jest.fn(async () => {
      if (fails) throw new Error("private provider error");
      return {
        stream: new ReadableStream({
          start(controller) {
            parts.forEach((p) => controller.enqueue(p));
            controller.close();
          },
        }),
      };
    }),
  } as unknown as LanguageModel;
}
async function consumeModel(source: LanguageModel) {
  if (typeof source === "string") throw new Error("unexpected model ID");
  const result = await source.doStream({ prompt: [], maxOutputTokens: 100 });
  const reader = result.stream.getReader();
  const output = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    output.push(next.value);
  }
  return output;
}
async function consume(
  telemetry: AbliteratedModelTelemetry,
  source: LanguageModel,
  stepIndex = 0,
) {
  return consumeModel(telemetry.wrap(source, stepIndex));
}
describe("Abliteration stream telemetry", () => {
  const capture = jest.fn();
  const create = () =>
    new AbliteratedModelTelemetry({ capture }, "user", {
      assignment: {
        key: ABLITERATED_EXPERIMENT_KEY,
        variant: "test",
        modelKey: "model-abliterated",
        baselineModel: "model-deepseek-v4-flash-0731",
      },
      messageId: "message",
      chatId: "chat",
      mode: "ask",
      subscription: "pro",
    });
  beforeEach(() => capture.mockClear());
  const events = (name: string) =>
    capture.mock.calls.map(([event]) => event).filter((e) => e.event === name);
  it("attributes free Ask exposure to its own experiment when recovery serves GLM", async () => {
    const telemetry = new AbliteratedModelTelemetry({ capture }, "user", {
      assignment: {
        key: FREE_ASK_ABLITERATED_EXPERIMENT_KEY,
        variant: "test",
        modelKey: "model-abliterated",
        baselineModel: "ask-model-free-glm",
      },
      messageId: "message",
      chatId: "chat",
      mode: "ask",
      subscription: "free",
    });
    await expect(consume(telemetry, model([], true))).rejects.toThrow();
    telemetry.setMessageId("replacement");
    await consume(
      telemetry,
      model(
        [{ type: "text-delta", id: "t", delta: "answer" }, finishPart],
        false,
        "z-ai/glm-5.3-flash",
      ),
    );
    expect(events("abliterated_model_exposed")).toHaveLength(1);
    expect(events("abliterated_model_exposed")[0].properties).toMatchObject({
      experiment_key: FREE_ASK_ABLITERATED_EXPERIMENT_KEY,
      experiment_variant: "test",
      experiment_request_id: "message",
      message_id: "replacement",
      response_model: "z-ai/glm-5.3-flash",
      platform_authorization_context: "standard",
    });
    expect(events("abliterated_model_eligible")[0].properties).toMatchObject({
      assigned_platform_authorization_context: "not_appended",
      baseline_model: "ask-model-free-glm",
    });
  });
  it("aggregates attempts while preserving eligibility and output without leaking content", async () => {
    const telemetry = create();
    expect(events("abliterated_model_exposed")).toHaveLength(0);
    const parts = [
      { type: "text-delta", id: "t", delta: "private answer" },
      finishPart,
    ];
    expect(await consume(telemetry, model(parts))).toEqual(parts);
    await consume(telemetry, model(parts), 1);
    expect(events("abliterated_model_eligible")).toHaveLength(1);
    expect(events("abliterated_model_eligible")[0].properties).toMatchObject({
      assigned_platform_authorization_context: "not_appended",
      generation_step_limit: 1,
    });
    expect(events("abliterated_model_provider_attempt")).toHaveLength(0);
    expect(events("abliterated_model_provider_outcome")).toHaveLength(1);
    expect(telemetry.getSummary()).toMatchObject({
      telemetry_version: 2,
      provider_attempt_count: 2,
      provider_completed_count: 2,
      provider_pending_count: 0,
    });
    expect(events("abliterated_model_exposed")).toHaveLength(1);
    expect(
      events("abliterated_model_provider_outcome")[0].properties,
    ).toMatchObject({
      outcome: "completed",
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 2,
      platform_authorization_context: "not_appended",
      generation_step: 1,
      within_abliteration_step_limit: true,
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain("private answer");
  });
  it.each(["test", "control"] as const)(
    "keeps event volume constant across 500 successful steps for %s",
    async (variant) => {
      const telemetry = new AbliteratedModelTelemetry({ capture }, "user", {
        assignment: {
          key: ABLITERATED_EXPERIMENT_KEY,
          variant,
          modelKey:
            variant === "test"
              ? "model-abliterated"
              : "model-deepseek-v4-flash-0731",
          baselineModel: "model-deepseek-v4-flash-0731",
        },
        messageId: "message",
        chatId: "chat",
        mode: "agent",
        subscription: "free",
      });
      const parts = [
        { type: "text-delta", id: "t", delta: "private answer" },
        finishPart,
      ];
      for (let step = 0; step < 500; step++) {
        const source = model(
          parts,
          false,
          step === 0 && variant === "test"
            ? "abliterated-model"
            : "deepseek/deepseek-v4-flash-0731",
        );
        expect(await consume(telemetry, source, step)).toEqual(parts);
      }
      expect(capture).toHaveBeenCalledTimes(3); // eligibility, exposure, first outcome
      expect(
        events("abliterated_model_provider_outcome")[0].properties,
      ).toMatchObject({
        generation_step: 1,
        experiment_variant: variant,
        outcome: "completed",
      });
      expect(telemetry.getSummary()).toMatchObject({
        provider_attempt_count: 500,
        provider_outcome_count: 500,
        provider_completed_count: 500,
        provider_pending_count: 0,
        provider_continuation_completed_count: 499,
        provider_abliteration_attempt_count: variant === "test" ? 1 : 0,
        provider_baseline_attempt_count: variant === "test" ? 499 : 500,
        provider_usage_reported_count: 500,
        provider_input_tokens: 5000,
        provider_output_tokens: 2500,
        provider_cache_read_tokens: 1000,
        provider_reasoning_tokens: 500,
      });
      expect(
        telemetry.getSummary().provider_estimated_cost_dollars,
      ).toBeGreaterThan(0);
      expect(JSON.stringify(capture.mock.calls)).not.toContain(
        "private answer",
      );
    },
  );
  it.each([
    ["length", "truncated"],
    ["content-filter", "content_filter"],
    ["error", "error"],
    ["stop", "empty"],
  ])("retains later-step %s diagnostics", async (reason, outcome) => {
    const telemetry = create();
    await consume(
      telemetry,
      model([
        { ...finishPart, finishReason: { unified: reason, raw: reason } },
      ]),
      499,
    );
    expect(
      events("abliterated_model_provider_outcome")[0].properties,
    ).toMatchObject({ generation_step: 500, outcome });
    expect(telemetry.getSummary()).toMatchObject({
      provider_attempt_count: 1,
      provider_outcome_count: 1,
      [`provider_${outcome}_count`]: 1,
    });
  });
  it("retains late failures and totals across fallback message replacement", async () => {
    const telemetry = create();
    await expect(consume(telemetry, model([], true), 4)).rejects.toThrow();
    telemetry.setMessageId("fallback-message");
    await consume(
      telemetry,
      model(
        [{ type: "text-delta", id: "t", delta: "ok" }, finishPart],
        false,
        "deepseek/deepseek-v4-flash-0731",
      ),
      4,
    );
    expect(events("abliterated_model_provider_outcome")).toHaveLength(1);
    expect(
      events("abliterated_model_provider_outcome")[0].properties,
    ).toMatchObject({ generation_step: 5, outcome: "error" });
    expect(
      events("abliterated_model_message_linked")[0].properties,
    ).toMatchObject({
      experiment_request_id: "message",
      message_id: "fallback-message",
    });
    expect(telemetry.getSummary()).toMatchObject({
      provider_attempt_count: 2,
      provider_error_count: 1,
      provider_completed_count: 1,
      provider_usage_reported_count: 1,
    });
  });
  it("retains failed attempts without inventing exposure, then records fallback exposure", async () => {
    const telemetry = create();
    await expect(consume(telemetry, model([], true))).rejects.toThrow();
    expect(events("abliterated_model_exposed")).toHaveLength(0);
    await consume(
      telemetry,
      model([
        { type: "response-metadata", modelId: "fallback-model" },
        { type: "text-delta", id: "t", delta: "ok" },
        finishPart,
      ]),
    );
    expect(events("abliterated_model_exposed")[0].properties).toMatchObject({
      response_model: "fallback-model",
      attempt: 2,
    });
    expect(events("abliterated_model_provider_outcome")).toHaveLength(2);
    expect(JSON.stringify(capture.mock.calls)).not.toContain(
      "private provider error",
    );
  });
  it("counts an error followed by finish only once", async () => {
    const telemetry = create();
    await consume(
      telemetry,
      model([{ type: "error", error: "private error" }, finishPart]),
      3,
    );
    expect(events("abliterated_model_provider_outcome")).toHaveLength(1);
    expect(telemetry.getSummary()).toMatchObject({
      provider_outcome_count: 1,
      provider_error_count: 1,
      provider_completed_count: 0,
      provider_pending_count: 0,
    });
  });
  it("retains incomplete continuation outcomes", async () => {
    const telemetry = create();
    await consume(telemetry, model([]), 2);
    expect(
      events("abliterated_model_provider_outcome")[0].properties.outcome,
    ).toBe("incomplete");
    expect(telemetry.getSummary().provider_incomplete_count).toBe(1);
  });
  it("propagates cancellation and retains the aborted continuation outcome", async () => {
    const telemetry = create();
    const source = model([]);
    if (typeof source === "string") throw new Error("unexpected model");
    const cancel = jest.fn();
    source.doStream = jest.fn(async () => ({
      stream: new ReadableStream({ cancel }),
    }));
    const wrapped = telemetry.wrap(source, 4);
    if (typeof wrapped === "string") throw new Error("unexpected model");
    const result = await wrapped.doStream({ prompt: [] });
    const pending = telemetry.getSummary();
    expect(pending.provider_pending_count).toBe(1);
    await result.stream.cancel("stop");
    expect(cancel).toHaveBeenCalledWith("stop");
    expect(
      events("abliterated_model_provider_outcome")[0].properties,
    ).toMatchObject({ generation_step: 5, outcome: "aborted" });
    expect(telemetry.getSummary()).toMatchObject({
      provider_aborted_count: 1,
      provider_pending_count: 0,
      provider_outcome_count: 1,
    });
    expect(pending.provider_pending_count).toBe(1); // snapshots cannot change after capture
  });
  it("does not call reasoning-only output a successful answer", async () => {
    await consume(
      create(),
      model([
        { type: "reasoning-delta", id: "r", delta: "private reasoning" },
        finishPart,
      ]),
    );
    expect(events("abliterated_model_exposed")).toHaveLength(0);
    expect(
      events("abliterated_model_provider_outcome")[0].properties.outcome,
    ).toBe("empty");
    expect(JSON.stringify(capture.mock.calls)).not.toContain(
      "private reasoning",
    );
  });
  it.each(["length", "content-filter", "error"])(
    "records %s without counting it as completion",
    async (reason) => {
      await consume(
        create(),
        model([
          { ...finishPart, finishReason: { unified: reason, raw: reason } },
        ]),
      );
      expect(
        events("abliterated_model_provider_outcome")[0].properties.outcome,
      ).not.toBe("completed");
    },
  );
  it("records content-filter usage before the response guard emits its error", async () => {
    const telemetry = create();
    const telemetryModel = telemetry.wrap(
      model([
        {
          ...finishPart,
          finishReason: { unified: "content-filter", raw: "content-filter" },
        },
      ]),
      0,
    );
    const output = await consumeModel(
      guardLanguageModelProviderResponse(telemetryModel),
    );

    expect(output.map((part) => part.type)).toEqual(["error", "finish"]);
    expect(
      events("abliterated_model_provider_outcome")[0].properties,
    ).toMatchObject({
      outcome: "content_filter",
      finish_reason: "content-filter",
      input_tokens: 10,
      output_tokens: 5,
    });
  });
  it("tracks tool activity without recording tool inputs", async () => {
    await consume(
      create(),
      model([
        {
          type: "tool-call",
          toolCallId: "t",
          toolName: "shell",
          input: "private payload",
        },
        finishPart,
      ]),
    );
    expect(events("abliterated_model_exposed")).toHaveLength(1);
    expect(
      events("abliterated_model_provider_outcome")[0].properties
        .tool_call_count,
    ).toBe(1);
    expect(JSON.stringify(capture.mock.calls)).not.toContain("private payload");
  });
  it("leaves streams working when analytics fails", async () => {
    capture.mockImplementation(() => {
      throw new Error("analytics offline");
    });
    expect(await consume(create(), model([finishPart]))).toEqual([finishPart]);
    capture.mockReset();
  });
  it("persists actual successful Abliteration use after later baseline steps", async () => {
    const telemetry = create();
    const parts = [{ type: "text-delta", id: "t", delta: "ok" }, finishPart];
    expect(telemetry.getRoutingMarker(true).completed).toBe(false);
    await consume(telemetry, model(parts));
    await consume(
      telemetry,
      model([{ type: "response-metadata", modelId: "baseline" }, ...parts]),
      1,
    );
    expect(telemetry.getRoutingMarker(true)).toEqual({
      version: 1,
      source: "moderation",
      completed: true,
    });
    expect(telemetry.getRoutingMarker(false).completed).toBe(false);
    telemetry.setMessageId("retry");
    expect(telemetry.getRoutingMarker(true).completed).toBe(false);
  });
  it("does not persist failed, empty, or fallback output as an independent seed", async () => {
    for (const parts of [
      [finishPart],
      [
        { type: "text-delta", id: "t", delta: "partial" },
        { type: "error", error: "failure" },
      ],
      [
        { type: "response-metadata", modelId: "baseline" },
        { type: "text-delta", id: "t", delta: "ok" },
        finishPart,
      ],
    ]) {
      const telemetry = create();
      await consume(telemetry, model(parts));
      expect(telemetry.getRoutingMarker(true).completed).toBe(false);
    }
  });
  it("retains inherited provenance even when the provider succeeds", async () => {
    const telemetry = new AbliteratedModelTelemetry({ capture }, "user", {
      assignment: {
        key: ABLITERATED_EXPERIMENT_KEY,
        variant: "test",
        modelKey: "model-abliterated",
        baselineModel: "model-deepseek-v4-flash-0731",
        selectionSource: "history",
        independentHistoryCount: 2,
      },
      messageId: "m",
      chatId: "c",
      mode: "agent",
      subscription: "pro",
    });
    await consume(
      telemetry,
      model([{ type: "text-delta", id: "t", delta: "ok" }, finishPart]),
    );
    expect(telemetry.getRoutingMarker(true)).toEqual({
      version: 1,
      source: "history",
      completed: true,
    });
    expect(events("abliterated_model_exposed")[0].properties).toMatchObject({
      selection_source: "history",
      moderation_eligible: false,
      independent_history_count: 2,
    });
  });
});
