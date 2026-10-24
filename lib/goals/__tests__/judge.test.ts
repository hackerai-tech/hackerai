jest.mock("ai", () => ({
  generateText: jest.fn(),
  Output: { object: (value: unknown) => value },
}));
jest.mock("../server", () => ({ goalServiceKey: () => "synthetic" }));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockPriorEvidence }),
}));
jest.mock("@/lib/ai/providers", () => ({
  myProvider: { languageModel: jest.fn() },
}));
jest.mock("@/lib/chat/agent-auto-review", () => ({
  AGENT_AUTO_REVIEW_MODEL: "standard",
  AGENT_AUTO_REVIEW_PROVIDER_OPTIONS: {
    openrouter: { reasoning: { enabled: false }, models: ["fallback"] },
  },
}));
jest.mock("@/lib/provider-usage-cost", () => ({
  getProviderUsageRawModelCost: () => 0.004,
}));
jest.mock("@/lib/rate-limit", () => ({
  calculateRawModelUsageCostDollars: () => 0.006,
}));
import { generateText } from "ai";
import { buildGoalCompletionEvidence, judgeGoalCompletion } from "../judge";
import type { Doc } from "@/convex/_generated/dataModel";
import type { UIMessage } from "ai";
const mockPriorEvidence = jest.fn();
const generate = generateText as jest.Mock;
const goal = {
  chatId: "chat",
  userId: "owner",
  objective: "Create marker",
  criteria: ["Marker exists"],
  checkpoint: {
    outcome: "achieved",
    progress: "Marker created",
    evidence: [
      {
        criterion: 0,
        runId: "r1",
        toolCallId: "cmd",
        explanation: "Observed marker",
      },
    ],
  },
} as unknown as Doc<"agent_goals">;
const messages = [
  {
    id: "r1",
    role: "assistant",
    parts: [
      {
        type: "tool-run_terminal_cmd",
        toolCallId: "cmd",
        state: "output-available",
        input: { command: "test -f marker" },
        output: { result: { exitCode: 0, output: "marker exists" } },
      },
    ],
  },
] as UIMessage[];
describe("independent goal completion check", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPriorEvidence.mockResolvedValue([]);
  });
  it("uses actual results and bills the separate completion check", async () => {
    generate.mockResolvedValue({
      output: { verdict: "done", reason: "Marker observed" },
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    const cost = jest.fn();
    expect(await judgeGoalCompletion(goal, messages, "r1", cost)).toEqual({
      verdict: "done",
      reason: "Marker observed",
    });
    const call = generate.mock.calls[0][0];
    expect(JSON.parse(call.prompt).evidence[0].result).toContain(
      "marker exists",
    );
    expect(call.tools).toBeUndefined();
    expect(call.maxRetries).toBe(0);
    expect(call.providerOptions.openrouter.reasoning).toEqual({
      effort: "low",
    });
    expect(call.providerOptions.openrouter.models).toEqual(["fallback"]);
    expect(cost).toHaveBeenCalledWith(0.004);
  });
  it("continues without spending on a judge when a verification gate fails", async () => {
    const cost = jest.fn();
    expect(
      (
        await judgeGoalCompletion(
          { ...goal, verificationCommand: "different command" },
          messages,
          "r1",
          cost,
        )
      )?.verdict,
    ).toBe("continue");
    expect(generate).not.toHaveBeenCalled();
    expect(cost).not.toHaveBeenCalled();
  });
  it("cannot accept invented evidence and stops safely on verifier failure", async () => {
    expect(
      (await judgeGoalCompletion(goal, [], "r1", jest.fn()))?.verdict,
    ).toBe("continue");
    expect(generate).not.toHaveBeenCalled();
    generate.mockRejectedValue(new Error("Unavailable"));
    expect(
      (await judgeGoalCompletion(goal, messages, "r1", jest.fn()))?.verdict,
    ).toBe("blocked");
  });
  it("blocks safely when saved evidence cannot be read", async () => {
    mockPriorEvidence.mockRejectedValue(new Error("Storage unavailable"));
    expect(
      (await judgeGoalCompletion(goal, messages, "r1", jest.fn()))?.verdict,
    ).toBe("blocked");
    expect(generate).not.toHaveBeenCalled();
  });
  it("uses the fallback message while preserving the run's identity", async () => {
    generate.mockResolvedValue({
      output: { verdict: "done", reason: "Marker observed" },
      usage: {},
    });
    await judgeGoalCompletion(
      goal,
      [{ ...messages[0], id: "retry" }],
      "r1",
      jest.fn(),
      "retry",
    );
    expect(JSON.parse(generate.mock.calls[0][0].prompt).evidence[0].runId).toBe(
      "r1",
    );
  });
});

it("retains earlier-stage evidence for the same criterion when judging a later run", async () => {
  jest.clearAllMocks();
  mockPriorEvidence.mockResolvedValue([
    {
      criterion: 0,
      runId: "earlier",
      toolCallId: "prepare",
      explanation: "Prepared marker",
      result: "Stage one verified",
    },
  ]);
  generate.mockResolvedValue({
    output: { verdict: "done", reason: "Both stages verified" },
    usage: {},
  });
  await judgeGoalCompletion(goal, messages, "r1", jest.fn());
  const evidence = JSON.parse(generate.mock.calls[0][0].prompt).evidence;
  expect(evidence.map((e: { runId: string }) => e.runId)).toEqual([
    "earlier",
    "r1",
  ]);
});

describe("provider retry evidence", () => {
  const final = {
    id: "retry-final",
    role: "assistant",
    parts: [],
  } as UIMessage;

  it("retains executed evidence on the original response after retry", () => {
    const result = buildGoalCompletionEvidence(
      goal,
      [...messages, final],
      "r1",
      final.id,
    );
    expect(result.proofs).toHaveLength(1);
    expect(result.proofs[0].result).toContain("marker exists");
    expect(result.proofs[0].runId).toBe("r1");
  });

  it("includes an explicitly registered intermediate retry response", () => {
    const result = buildGoalCompletionEvidence(
      goal,
      [{ ...messages[0], id: "retry-first" }, final],
      "r1",
      final.id,
      ["r1", "retry-first", final.id],
    );
    expect(result.proofs).toHaveLength(1);
  });

  it("rejects unrelated history, user parts and failed tool results", () => {
    const unrelated = { ...messages[0], id: "old-run" };
    const user = { ...messages[0], role: "user" } as UIMessage;
    const failed = {
      ...messages[0],
      parts: [
        {
          ...messages[0].parts[0],
          state: "output-error",
          errorText: "Unknown outcome",
        },
      ],
    } as UIMessage;
    for (const source of [unrelated, user, failed]) {
      expect(
        buildGoalCompletionEvidence(goal, [source, final], "r1", final.id)
          .proofs,
      ).toEqual([]);
    }
  });

  it("requires the verification command in the final response", () => {
    const withGate = { ...goal, verificationCommand: "test -f marker" };
    const result = buildGoalCompletionEvidence(
      withGate,
      [...messages, final],
      "r1",
      final.id,
    );
    expect(result.proofs).toHaveLength(1);
    expect(result.gatePassed).toBe(false);
    expect(
      buildGoalCompletionEvidence(
        withGate,
        [...messages, { ...final, parts: messages[0].parts }],
        "r1",
        final.id,
      ).gatePassed,
    ).toBe(true);
  });
});
