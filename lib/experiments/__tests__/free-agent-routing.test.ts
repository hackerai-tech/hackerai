import { myProvider } from "@/lib/ai/providers";
import { selectModel } from "@/lib/chat/chat-processor";
import { buildProviderOptions } from "@/lib/api/chat-stream-helpers";
import {
  resolveAgentModelAfterSummarization,
  resolveAgentModelForImageToolResults,
} from "@/lib/api/agent-stream-runner";
import { evaluateFlashRouting } from "../flash-routing";

it.each([false, true])(
  "keeps Free Agent on GLM without a routing flag lookup (PDF=%s)",
  async (hasPdf) => {
    const posthog = {
      evaluateFlags: jest.fn(),
      getFeatureFlagResult: jest.fn().mockResolvedValue({
        enabled: true,
        variant: "test",
      }),
    };
    const baseline = selectModel("agent", "free", "auto", false, hasPdf);
    const assignment = await evaluateFlashRouting({
      posthog,
      userId: "free-user",
      subscription: "free",
      mode: "agent",
      selectedModel: baseline,
      hasImages: false,
    });

    expect(
      myProvider.languageModel(assignment?.modelKey ?? baseline).modelId,
    ).toBe("z-ai/glm-5.3-flash");
    expect(assignment).toBeUndefined();
    expect(posthog.getFeatureFlagResult).not.toHaveBeenCalled();
    expect(posthog.evaluateFlags).not.toHaveBeenCalled();
  },
);

it("preserves Free Agent reasoning and GLM through compaction and image tool results", () => {
  const model = selectModel("agent", "free");
  expect(
    buildProviderOptions(true, "free-user", model, "agent").openrouter,
  ).not.toHaveProperty("reasoning");
  expect(resolveAgentModelAfterSummarization(model, "agent", false)).toBe(
    model,
  );
  expect(
    resolveAgentModelForImageToolResults(
      model,
      "agent",
      true,
      "auto",
      false,
      true,
      "free",
    ),
  ).toBe(model);
});
