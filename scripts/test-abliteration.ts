/** Bounded live provider smoke test. No customer data or PostHog ingestion. */
import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { streamText, stepCountIs, tool } from "ai";
import { z } from "zod";

async function main() {
  // Load only this credential; never select or modify a Convex/Vercel/Trigger environment.
  process.env.ABLITERATION_API_KEY ??= parse(
    readFileSync(".env.local"),
  ).ABLITERATION_API_KEY;
  if (!process.env.ABLITERATION_API_KEY?.trim())
    throw new Error("MissingCredential");
  const { myProvider } = await import("../lib/ai/providers");
  const { AbliteratedModelTelemetry } =
    await import("../lib/analytics/abliterated-model");
  const { evaluateAbliteratedModel } =
    await import("../lib/experiments/abliterated-model");
  const { namespaceLanguageModelToolCalls } =
    await import("../lib/ai/tool-call-id-namespace");
  const events: Array<{ event: string; properties?: Record<string, unknown> }> =
    [];
  const useLargeV2 = process.argv.includes("--large-v2");
  const expectedProviderModel = useLargeV2
    ? "abliterated-model-large-v2"
    : "abliterated-model";
  const assignment = await evaluateAbliteratedModel({
    posthog: { getFeatureFlag: async () => "test" },
    userId: "local-provider-smoke",
    selectedModel: useLargeV2
      ? "model-deepseek-v4-pro-0813"
      : "model-deepseek-v4-flash-0731",
    subscription: "pro",
    selectedModelOverride: useLargeV2 ? "hackerai-pro" : "hackerai-standard",
    moderationEligible: true,
    messages: [
      {
        id: "smoke",
        role: "user",
        parts: [{ type: "text", text: "Synthetic provider test" }],
      },
    ],
  });
  if (!assignment) throw new Error("AssignmentUnavailable");
  const telemetry = new AbliteratedModelTelemetry(
    {
      capture: (event) => {
        events.push(event);
      },
    },
    "local-provider-smoke",
    {
      assignment,
      messageId: "smoke",
      chatId: "smoke",
      mode: "agent",
      subscription: "pro",
    },
  );
  let toolExecutions = 0;
  const startedAt = Date.now();
  const result = streamText({
    model: namespaceLanguageModelToolCalls(
      telemetry.wrap(myProvider.languageModel(assignment.modelKey), 0),
      "smoke",
    ),
    prompt:
      "Use the add tool to add 2 and 3. Then answer with the result in one short sentence.",
    tools: {
      add: tool({
        description: "Add two integers.",
        inputSchema: z.object({ a: z.number().int(), b: z.number().int() }),
        execute: async ({ a, b }) => {
          toolExecutions++;
          return { sum: a + b };
        },
      }),
    },
    stopWhen: stepCountIs(3),
    maxOutputTokens: 1024,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(60_000),
  });
  for await (const part of result.fullStream) {
    if (part.type === "error") throw part.error;
  }
  const usage = await result.totalUsage;
  const response = await result.text;
  const responseModel = (await result.response).modelId;
  const outcomes = events.filter(
    (event) => event.event === "abliterated_model_provider_outcome",
  );
  const passed =
    toolExecutions === 1 &&
    responseModel === expectedProviderModel &&
    response.includes("5") &&
    events.filter((event) => event.event === "abliterated_model_exposed")
      .length === 1 &&
    outcomes.length === 2 &&
    outcomes.every((event) => event.properties?.outcome === "completed");
  console.log(
    JSON.stringify({
      test: useLargeV2
        ? "abliteration_large_v2_provider_and_telemetry"
        : "abliteration_provider_and_telemetry",
      passed,
      model: responseModel,
      toolExecutions,
      durationMs: Date.now() - startedAt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      capturedEventNames: events.map((event) => event.event),
    }),
  );
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  // Provider Error objects can contain request bodies. Print only bounded metadata.
  console.error(
    JSON.stringify({
      test: "abliteration_provider_and_telemetry",
      passed: false,
      errorName: error instanceof Error ? error.name : "UnknownError",
      statusCode:
        typeof error?.statusCode === "number" ? error.statusCode : undefined,
    }),
  );
  process.exitCode = 1;
});
