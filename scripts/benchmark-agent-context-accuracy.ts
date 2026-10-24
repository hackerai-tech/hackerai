import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { generateText, convertToModelMessages, type ModelMessage } from "ai";
import {
  contextAccuracyFixture,
  scoreContextAccuracy,
} from "../lib/feedback/context-accuracy-fixture";

// Run with: NODE_OPTIONS=--conditions=react-server pnpm exec tsx
// scripts/benchmark-agent-context-accuracy.ts [--live]
// No remote storage, tools, analytics, customers or flag evaluation. --live uses
// only this checkout's approved Development provider credentials.
config({ path: ".env.local", quiet: true });
async function main() {
  const live = process.argv.includes("--live");
  const fixtures = [
    contextAccuracyFixture(17, 11000),
    contextAccuracyFixture(43, 6000),
  ];
  const { getAgentContextBudget } =
    await import("../lib/ai/agent-context-budget");
  const { getSummarizationThresholdTokens } =
    await import("../lib/chat/summarization/constants");
  if (!live) {
    console.log(
      JSON.stringify({
        live: false,
        fixtures: fixtures.map((f) => ({
          id: f.id,
          bytes: JSON.stringify(f.messages).length,
        })),
        note: "Use --live for paid provider calls. Dry run is not fidelity evidence.",
      }),
    );
    return;
  }
  if (!process.env.ABLITERATION_API_KEY || !process.env.OPENROUTER_API_KEY)
    throw Error("Development provider configuration is incomplete");
  const { myProvider } = await import("../lib/ai/providers");
  const { estimateSummaryInputTokens } =
    await import("../lib/chat/summarization/helpers");
  const { compactModelMessagesInRun } =
    await import("../lib/chat/summarization");
  const {
    CompactionModelPolicy,
    COMPACTION_POLICY_VERSION,
    MAX_CONTEXT_COMPACTION_POLICY_VERSION,
    PRO_CONTEXT_COMPACTION_POLICY_VERSION,
  } = await import("../lib/chat/summarization/compaction-policy");
  const modelKey = "model-abliterated";
  const model = myProvider.languageModel(modelKey);
  const system =
    "You are a security assistant working on an offline synthetic fixture. Preserve scope, corrections, evidence status and existing running work. Do not invent completion or execute anything.";
  const rows: unknown[] = [];
  mkdirSync(".artifacts/context-accuracy", { recursive: true });
  // Freeze allocation locally; never evaluate or mutate the separate paused
  // moderation policy. Production compaction/fallback/validation code still runs.
  class SyntheticPolicy extends CompactionModelPolicy {
    constructor(
      private readonly expanded: boolean,
      private readonly tier: "hackerai-pro" | "hackerai-max",
    ) {
      super({
        userId: "synthetic-context-accuracy",
        runId: "synthetic",
        chatId: null,
        mode: "agent",
        subscription: "pro",
        baselineModel: modelKey,
        platformAuthorized: true,
        onDiscardedUsage: () => {},
      });
    }
    async resolve(): ReturnType<
      InstanceType<typeof CompactionModelPolicy>["resolve"]
    > {
      return {
        model: this.expanded
          ? ("model-abliterated-large-v2" as const)
          : ("model-abliterated" as const),
        fallbackModel: "model-glm-5.3-flash" as const,
        policy: this.expanded
          ? this.tier === "hackerai-pro"
            ? PRO_CONTEXT_COMPACTION_POLICY_VERSION
            : MAX_CONTEXT_COMPACTION_POLICY_VERSION
          : COMPACTION_POLICY_VERSION,
        flagEnabled: false,
        ...(this.expanded && { expandedAgentContext: true }),
      };
    }
    start(): ReturnType<InstanceType<typeof CompactionModelPolicy>["start"]> {
      return {
        onDiscardedUsage: () => {},
        attempt: () => {},
        finish: () => {},
      };
    }
  }
  for (const fixture of fixtures)
    for (const tier of ["hackerai-pro", "hackerai-max"] as const) {
      // Alternate order across fixture/tier to reduce systematic cache/time bias.
      const variants =
        fixture.id.includes("17") === (tier === "hackerai-pro")
          ? (["control", "test"] as const)
          : (["test", "control"] as const);
      for (const variant of variants) {
        const started = Date.now();
        let compactions = 0;
        const maxTokens = getAgentContextBudget({
          enabled: variant === "test",
          mode: "agent",
          subscription: "pro",
          modelId: model.modelId,
        });
        const base = {
          fixture: fixture.id,
          fixtureSha256: createHash("sha256")
            .update(JSON.stringify(fixture))
            .digest("hex"),
          tier,
          variant,
          model: model.modelId,
          maxTokens,
        };
        try {
          let rolling: ModelMessage[] = [];
          for (const message of fixture.messages) {
            rolling.push(message);
            if (
              estimateSummaryInputTokens(rolling) >
              getSummarizationThresholdTokens(maxTokens)
            ) {
              const compacted = await compactModelMessagesInRun({
                compactionPolicy: new SyntheticPolicy(variant === "test", tier),
                modelMessages: rolling,
                transcriptModelMessages: rolling,
                subscription: "pro",
                languageModel: model,
                mode: "agent",
                writer: {
                  write: () => {},
                  merge: () => {},
                  onError: () => "synthetic_error",
                },
                chatId: null,
                maxTokens,
                compactionIndex: ++compactions,
                hasExistingSummary: compactions > 1,
                chatSystemPrompt: system,
                abortSignal: AbortSignal.timeout(360_000),
              });
              if (!compacted) throw Error("Compaction produced no checkpoint");
              rolling = await convertToModelMessages([
                compacted.summaryMessage,
              ]);
            }
          }
          const result = await generateText({
            model,
            system,
            messages: [...rolling, { role: "user", content: fixture.question }],
            maxOutputTokens: 1024,
            maxRetries: 0,
            timeout: 120_000,
            providerOptions: { abliteration: { reasoningEffort: "low" } },
          });
          const score = scoreContextAccuracy(result.text, fixture.expected);
          rows.push({
            ...base,
            status: result.finishReason === "stop" ? "completed" : "incomplete",
            compactions,
            durationMs: Date.now() - started,
            score,
            inputTokens: result.usage.inputTokens ?? null,
          });
        } catch (error) {
          rows.push({
            ...base,
            status: "error",
            compactions,
            durationMs: Date.now() - started,
            errorType: error instanceof Error ? error.name : "unknown",
          });
        }
        writeFileSync(
          ".artifacts/context-accuracy/results.json",
          JSON.stringify(
            {
              scope:
                "synthetic compaction and continuation; not full Agent/native/customer preference",
              rows,
            },
            null,
            2,
          ),
        );
        console.log(JSON.stringify(rows.at(-1)));
      }
    }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.name : "benchmark_failed");
  process.exitCode = 1;
});
