import type { LanguageModel } from "ai";
import { AbliteratedModelTelemetry } from "../abliterated-model";
import { guardLanguageModelProviderResponse } from "@/lib/ai/provider-response-guard";
import { ABLITERATED_EXPERIMENT_KEY } from "@/lib/experiments/abliterated-model";

const finishPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 10, cacheRead: 2 },
    outputTokens: { total: 5, reasoning: 1 },
  },
};
function model(parts: unknown[], fails = false): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "abliterated-model",
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
  it("distinguishes eligibility, attempts and actual output, without leaking content", async () => {
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
    expect(events("abliterated_model_provider_attempt")).toHaveLength(2);
    expect(
      events("abliterated_model_provider_attempt").map(
        (event) => event.properties.generation_step,
      ),
    ).toEqual([1, 2]);
    expect(
      events("abliterated_model_provider_attempt").map(
        (event) => event.properties.within_abliteration_step_limit,
      ),
    ).toEqual([true, false]);
    expect(events("abliterated_model_exposed")).toHaveLength(1);
    expect(
      events("abliterated_model_provider_outcome")[0].properties,
    ).toMatchObject({
      outcome: "completed",
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 2,
      platform_authorization_context: "not_appended",
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain("private answer");
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
});
