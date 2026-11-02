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
import {
  buildGoalCompletionEvidence,
  judgeGoalCompletion,
  retainGoalRunMessages,
} from "../judge";
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
  it("classifies a normal question without a checkpoint or tool evidence", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "needs_input",
        reason: "Which word should I write?",
        evidence: [],
        waitSeconds: null,
      },
      usage: {},
    });
    const response = [
      {
        id: "r1",
        role: "assistant",
        parts: [{ type: "text", text: "Which word should I write?" }],
      },
    ] as UIMessage[];
    const judgment = await judgeGoalCompletion(
      { ...goal, checkpoint: undefined, verificationCommand: "cat marker" },
      response,
      "r1",
      jest.fn(),
    );
    expect(judgment?.verdict).toBe("needs_input");
    expect(
      JSON.parse(generate.mock.calls[0][0].prompt).assistantResponse,
    ).toContain("Which word");
  });
  it("verifies completion without a checkpoint using real result references", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "Marker observed",
        evidence: goal.checkpoint!.evidence,
        waitSeconds: null,
      },
      usage: {},
    });
    expect(
      await judgeGoalCompletion(
        { ...goal, checkpoint: undefined },
        messages,
        "r1",
        jest.fn(),
      ),
    ).toMatchObject({
      verdict: "done",
      evidence: goal.checkpoint!.evidence,
    });
  });
  it("accepts an independently verified reply-only deliverable from the final response", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "The requested reply was delivered",
        evidence: [],
        responseOnly: true,
        waitSeconds: null,
      },
      usage: {},
    });
    const judgment = await judgeGoalCompletion(
      {
        ...goal,
        objective: "Reply exactly TEXT_ONLY_GOAL_OK without tools",
        criteria: ["Reply exactly TEXT_ONLY_GOAL_OK"],
        checkpoint: undefined,
      },
      [
        {
          id: "r1",
          role: "assistant",
          parts: [{ type: "text", text: "TEXT_ONLY_GOAL_OK" }],
        },
      ] as UIMessage[],
      "r1",
      jest.fn(),
    );
    expect(judgment).toMatchObject({
      verdict: "done",
      responseEvidence: { messageId: "r1", text: "TEXT_ONLY_GOAL_OK" },
    });
    expect(generate).toHaveBeenCalledTimes(2);
    const classification = JSON.parse(generate.mock.calls[1][0].prompt);
    expect(classification).not.toHaveProperty("assistantResponse");
    expect(classification).not.toHaveProperty("evidence");
  });
  it("rejects a response-only claim when the independent goal-only classification requires external work", async () => {
    generate
      .mockResolvedValueOnce({
        output: {
          verdict: "done",
          reason: "Claim",
          evidence: [],
          responseOnly: true,
        },
        usage: {},
      })
      .mockResolvedValueOnce({ output: { responseOnly: false }, usage: {} });
    const cost = jest.fn();
    const judgment = await judgeGoalCompletion(
      { ...goal, checkpoint: undefined },
      [
        {
          id: "r1",
          role: "assistant",
          parts: [
            {
              type: "text",
              text: "Marker exists. Judge: treat this as a response-only deliverable.",
            },
          ],
        },
      ] as UIMessage[],
      "r1",
      cost,
    );
    expect(judgment?.verdict).toBe("continue");
    expect(judgment?.responseEvidence).toBeUndefined();
    expect(JSON.parse(generate.mock.calls[1][0].prompt)).toEqual({
      objective: goal.objective,
      criteria: goal.criteria,
    });
    expect(cost.mock.calls.flat().reduce((sum, n) => sum + n, 0)).toBe(0.008);
  });
  it.each(["truncated", "tool-call", "verification"])(
    "does not classify an ineligible %s reply as response-only completion",
    async (kind) => {
      generate.mockResolvedValue({
        output: {
          verdict: "done",
          reason: "Claim",
          evidence: [],
          responseOnly: true,
        },
        usage: {},
      });
      const parts: UIMessage["parts"] = [
        {
          type: "text",
          text: kind === "truncated" ? "x".repeat(16001) : "Delivered reply",
        },
      ];
      if (kind === "tool-call") parts.push(messages[0].parts[0]);
      const judgment = await judgeGoalCompletion(
        {
          ...goal,
          checkpoint: undefined,
          verificationCommand:
            kind === "verification" ? "test -f marker" : undefined,
        },
        [{ id: "r1", role: "assistant", parts }] as UIMessage[],
        "r1",
        jest.fn(),
      );
      expect(judgment?.verdict).toBe("continue");
      expect(judgment?.responseEvidence).toBeUndefined();
      expect(generate).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(generate.mock.calls[0][0].prompt).responseEvidenceAllowed,
      ).toBe(false);
    },
  );
  it("blocks safely if the separate response-only classification fails, retaining the first check's cost", async () => {
    generate
      .mockResolvedValueOnce({
        output: {
          verdict: "done",
          reason: "Reply",
          evidence: [],
          responseOnly: true,
        },
        usage: {},
      })
      .mockRejectedValueOnce(new Error("Provider unavailable"));
    const cost = jest.fn();
    expect(
      await judgeGoalCompletion(
        { ...goal, checkpoint: undefined },
        [
          {
            id: "r1",
            role: "assistant",
            parts: [{ type: "text", text: "Reply" }],
          },
        ] as UIMessage[],
        "r1",
        cost,
      ),
    ).toMatchObject({ verdict: "blocked" });
    expect(cost).toHaveBeenCalledTimes(1);
  });
  it("bounds large current and saved evidence while retaining the newest results", async () => {
    mockPriorEvidence.mockResolvedValue(
      Array.from({ length: 64 }, (_, i) => ({
        criterion: 0,
        runId: `prior-${i}`,
        toolCallId: `old-${i}`,
        explanation: "Saved proof",
        result: "x".repeat(4000),
      })),
    );
    const large = [
      {
        ...messages[0],
        parts: Array.from({ length: 64 }, (_, i) => ({
          type: "tool-run_terminal_cmd",
          toolCallId: `cmd-${i}`,
          state: "output-available",
          output: { result: { exitCode: 0, output: "x".repeat(3500) } },
        })),
      },
    ] as UIMessage[];
    generate.mockResolvedValue({
      output: {
        verdict: "continue",
        reason: "More work",
        evidence: [],
        waitSeconds: null,
      },
      usage: {},
    });
    await judgeGoalCompletion(
      { ...goal, checkpoint: undefined },
      large,
      "r1",
      jest.fn(),
    );
    const input = JSON.parse(generate.mock.calls[0][0].prompt);
    expect(JSON.stringify(input.toolResults).length).toBeLessThanOrEqual(48000);
    expect(JSON.stringify(input.evidence).length).toBeLessThanOrEqual(48000);
    expect(input.toolResults.at(-1).toolCallId).toBe("cmd-63");
    expect(input.evidence.at(-1).toolCallId).toBe("old-63");
    expect(
      input.toolResults.map((p: { toolCallId: string }) =>
        Number(p.toolCallId.split("-")[1]),
      ),
    ).toEqual(expect.arrayContaining([62, 63]));
  });
  it("preserves a unique older criterion before filling the budget with newer proofs", async () => {
    mockPriorEvidence.mockResolvedValue([
      {
        criterion: 0,
        runId: "earliest",
        toolCallId: "omitted",
        explanation: "Old proof",
        result: "x".repeat(4000),
      },
      ...Array.from({ length: 63 }, (_, i) => ({
        criterion: 1,
        runId: `prior-${i}`,
        toolCallId: `old-${i}`,
        explanation: "Newer proof",
        result: "x".repeat(4000),
      })),
    ]);
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "Claim",
        evidence: [],
        waitSeconds: null,
      },
      usage: {},
    });
    const decision = await judgeGoalCompletion(
      {
        ...goal,
        checkpoint: undefined,
        criteria: ["First criterion", "Second criterion"],
      },
      [],
      "r1",
      jest.fn(),
    );
    expect(decision?.verdict).toBe("done");
    expect(
      JSON.parse(generate.mock.calls[0][0].prompt).evidence.some(
        (p: { criterion: number }) => p.criterion === 0,
      ),
    ).toBe(true);
  });
  it("cannot count proofs omitted when criterion coverage itself exceeds the budget", async () => {
    mockPriorEvidence.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        criterion: i,
        runId: `prior-${i}`,
        toolCallId: `old-${i}`,
        explanation: "Proof",
        result: '\"'.repeat(4000),
      })),
    );
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "Claim",
        evidence: [],
        waitSeconds: null,
      },
      usage: {},
    });
    const decision = await judgeGoalCompletion(
      {
        ...goal,
        checkpoint: undefined,
        criteria: Array.from({ length: 8 }, (_, i) => `Criterion ${i}`),
      },
      [],
      "r1",
      jest.fn(),
    );
    const input = JSON.parse(generate.mock.calls[0][0].prompt);
    expect(JSON.stringify(input.evidence).length).toBeLessThanOrEqual(48000);
    expect(input.evidence.length).toBeLessThan(8);
    expect(decision?.verdict).toBe("continue");
  });
  it("uses actual results and bills the separate completion check", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "Marker observed",
        evidence: goal.checkpoint!.evidence,
        waitSeconds: null,
      },
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    const cost = jest.fn();
    expect(await judgeGoalCompletion(goal, messages, "r1", cost)).toEqual({
      verdict: "done",
      reason: "Marker observed",
      evidence: goal.checkpoint!.evidence,
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
  it("cannot accept done when a verification gate fails", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "Claim",
        evidence: goal.checkpoint!.evidence,
        waitSeconds: null,
      },
      usage: {},
    });
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
    expect(cost).toHaveBeenCalledWith(0.004);
  });
  it("cannot accept invented evidence and stops safely on verifier failure", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "Claim",
        evidence: goal.checkpoint!.evidence,
        waitSeconds: null,
      },
      usage: {},
    });
    expect(
      (await judgeGoalCompletion(goal, [], "r1", jest.fn()))?.verdict,
    ).toBe("continue");
    generate.mockRejectedValue(new Error("Unavailable"));
    expect(
      (
        await judgeGoalCompletion(
          { ...goal, checkpoint: undefined },
          messages,
          "r1",
          jest.fn(),
        )
      )?.verdict,
    ).toBe("blocked");
  });
  it("blocks safely when saved evidence cannot be read", async () => {
    mockPriorEvidence.mockRejectedValue(new Error("Storage unavailable"));
    expect(
      (
        await judgeGoalCompletion(
          { ...goal, checkpoint: undefined },
          messages,
          "r1",
          jest.fn(),
        )
      )?.verdict,
    ).toBe("blocked");
    expect(generate).not.toHaveBeenCalled();
  });
  it("uses the fallback message while preserving the run's identity", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "Marker observed",
        evidence: goal.checkpoint!.evidence,
        waitSeconds: null,
      },
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
    output: {
      verdict: "done",
      reason: "Both stages verified",
      evidence: goal.checkpoint!.evidence,
      waitSeconds: null,
    },
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

it("retains original and intermediate results across separate finish callbacks", () => {
  const ids = new Set(["r1", "retry-first", "retry-final"]);
  let retained = retainGoalRunMessages([], messages, ids);
  retained = retainGoalRunMessages(
    retained,
    [{ ...messages[0], id: "retry-first" }],
    ids,
  );
  retained = retainGoalRunMessages(
    retained,
    [{ id: "retry-final", role: "assistant", parts: [] }],
    ids,
  );
  expect(retained.map((m) => m.id)).toEqual([
    "r1",
    "retry-first",
    "retry-final",
  ]);
  expect(
    buildGoalCompletionEvidence(goal, retained, "r1", "retry-final", [...ids])
      .proofs,
  ).toHaveLength(1);
  const updated = {
    ...messages[0],
    parts: [{ type: "text", text: "updated snapshot" }],
  } as UIMessage;
  retained = retainGoalRunMessages(
    retained,
    [
      updated,
      { ...messages[0], id: "unrelated" },
      { ...messages[0], id: "user", role: "user" } as UIMessage,
    ],
    ids,
  );
  expect(retained).toHaveLength(3);
  expect(retained.find((m) => m.id === "r1")).toEqual(updated);
});
