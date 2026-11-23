/** @jest-environment node */
jest.mock("@trigger.dev/sdk", () => ({
  schemaTask: (config: unknown) => ({
    ...(config as object),
    batchTriggerAndWait: jest.fn(),
  }),
  logger: { warn: jest.fn() },
}));
jest.mock("ai", () => ({
  ...jest.requireActual("ai"),
  generateText: jest.fn(),
  Output: { object: jest.fn() },
}));
jest.mock("@/lib/ai/providers", () => ({
  GROK_4_6_SLUG: "test-model",
  myProvider: { languageModel: jest.fn() },
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn(), flush: jest.fn() },
}));
import { logger as triggerLogger } from "@trigger.dev/sdk";
import { generateText, NoOutputGeneratedError, Output } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { mockMutation, mockQuery } from "@/__mocks__/convex/browser";
import { myProvider } from "@/lib/ai/providers";
import { phLogger } from "@/lib/posthog/server";
import { analyzeUserResearchProfile, pmUserResearch } from "../user-research";
import { pmUserResearchResultSchema } from "@/lib/research/user-research";
import { ResearchContentFilterError } from "@/lib/research/structured-output-diagnostics";

const actualAi = jest.requireActual<typeof import("ai")>("ai");
const ctx = {
  run: { id: "run_06gt0000000000000000000001" },
  attempt: { number: 1 },
  deployment: { version: "20261114.1" },
};
const taskOptions = { ctx };
const child = analyzeUserResearchProfile as unknown as {
  run: (payload: object, options: object) => Promise<unknown>;
  batchTriggerAndWait: jest.Mock;
};
const parent = pmUserResearch as unknown as {
  run: (payload: object, options: object) => Promise<any>;
};
// Routes one research call through the installed SDK with an in-memory model
// whose final step stops without text (for length by default), so
// result.output throws.
const useNoOutputModelOnce = (
  finishReason: "length" | "content-filter" = "length",
  refusalText?: string,
) => {
  const model = new MockLanguageModelV3({
    doGenerate: {
      content: refusalText ? [{ type: "text", text: refusalText }] : [],
      finishReason: { unified: finishReason, raw: finishReason },
      usage: {
        inputTokens: {
          total: 900,
          noCache: 900,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 6_000, text: 0, reasoning: 6_000 },
      },
      warnings: [],
      response: {
        id: "gen-1731600000-Synthetic01",
        modelId: "synthetic",
        timestamp: new Date(0),
      },
    },
  });
  (generateText as jest.Mock).mockImplementationOnce(actualAi.generateText);
  (Output.object as jest.Mock).mockImplementationOnce(actualAi.Output.object);
  (myProvider.languageModel as jest.Mock).mockReturnValueOnce(model);
  return model;
};
// The xAI route and its Bedrock fallback both return the same response.
const useNoOutputModel = (
  finishReason: "length" | "content-filter" = "length",
  refusalText?: string,
) => [
  useNoOutputModelOnce(finishReason, refusalText),
  useNoOutputModelOnce(finishReason, refusalText),
];
const workerPayload = {
  analysisId: "4e84e3cf-f26b-47f2-a3ba-0e9bb9fdf8a0",
  userId: "user-1",
  pseudonym: "U01",
  question: "What work is useful?",
  maxChatsPerUser: 3,
  samplingMode: "representative",
};
const parentPayload = {
  ...workerPayload,
  userIds: ["user-1", "user-2", "user-3"],
  requestedBy: "test",
  cohortLabel: "Test sample",
  cohortSource: "posthog",
  posthogProjectId: 144137,
  cohortSelectedAt: 1,
  selectionQueryFingerprint: "a".repeat(64),
  selectionLimitations: [],
};
const profile = {
  summary: "A recurring workflow",
  userTypes: [],
  declaredContext: null,
  recurringJobs: [],
  workflowPatterns: [],
  toolsAndEnvironments: [],
  valueDrivers: [],
  frictionAndUnmetNeeds: [],
  reasonsToPay: [],
  confidence: "low",
  uncertainty: [],
};
const synthesis = {
  answerToQuestion: "Useful for validation",
  executiveSummary: "A limited sample",
  avatars: [
    {
      name: "Practitioner",
      definition: "Works independently",
      mainJob: "Validate findings",
      supportingUserTypes: ["bug_bounty_hunter"],
      pains: [],
      desiredOutcomes: [],
      reasonsToPay: [],
      productFeatures: [],
      objectionsAndTrustNeeds: [],
      acquisitionHypotheses: [],
      messageHypotheses: [],
      evidenceUserCount: 1,
      confidence: "low",
    },
  ],
  primaryAvatar: "Practitioner",
  secondaryAvatars: [],
  crossCohortPatterns: [],
  unknowns: [],
  followUpExperiments: [],
  privacyNote: "Aggregate only",
};
beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://test.convex.cloud";
  process.env.CONVEX_USER_RESEARCH_SERVICE_KEY = "test-key";
  mockMutation.mockResolvedValue({});
  (phLogger.flush as jest.Mock).mockResolvedValue(undefined);
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it.each([{ chats: [] }, { chats: [{ chatId: "empty", messages: [] }] }])(
  "skips an empty eligible sample without model calls or profile writes: %s",
  async ({ chats }) => {
    mockQuery.mockResolvedValueOnce(chats).mockResolvedValue({ messages: [] });
    await expect(child.run(workerPayload, taskOptions)).resolves.toEqual({
      status: "skipped",
      reason: "no_eligible_evidence",
      pseudonym: "U01",
      chatsReviewed: 0,
      messagesReviewed: 0,
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(mockMutation).not.toHaveBeenCalled();
  },
);

it("keeps database failures as failures", async () => {
  mockQuery.mockRejectedValueOnce(new Error("fetch failed"));
  await expect(child.run(workerPayload, taskOptions)).rejects.toThrow(
    "fetch failed",
  );
  expect(generateText).not.toHaveBeenCalled();
});

it("separates analyzed, skipped, and failed profiles in the persisted report and result", async () => {
  child.batchTriggerAndWait.mockResolvedValue({
    runs: [
      { ok: true, output: { status: "completed" } },
      {
        ok: true,
        output: { status: "skipped", reason: "no_eligible_evidence" },
      },
      { ok: false, error: { message: "fetch failed" } },
    ],
  });
  mockQuery.mockResolvedValue([
    {
      pseudonym: "U01",
      profile,
      coverage: {
        chatsReviewed: 1,
        messagesReviewed: 2,
        askChats: 1,
        agentChats: 0,
      },
    },
  ]);
  (generateText as jest.Mock).mockResolvedValue({
    output: synthesis,
    usage: {},
  });
  const result = await parent.run(parentPayload, taskOptions);
  expect(result).toMatchObject({
    failedProfiles: 1,
    skippedProfiles: 1,
    usersAnalyzed: 1,
    report: {
      coverage: {
        usersRequested: 3,
        usersAnalyzed: 1,
        profilesFailed: 1,
        profilesSkipped: 1,
      },
    },
  });
  expect(pmUserResearchResultSchema.safeParse(result).success).toBe(true);
  expect(mockMutation).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ report: result.report }),
  );
  const legacy = JSON.parse(JSON.stringify(result));
  delete legacy.skippedProfiles;
  delete legacy.report.coverage.profilesSkipped;
  expect(pmUserResearchResultSchema.safeParse(legacy).success).toBe(true);
  expect(phLogger.event).not.toHaveBeenCalled();
  expect(phLogger.flush).not.toHaveBeenCalled();
  expect(triggerLogger.warn).not.toHaveBeenCalled();
});

it("still fails synthesis when every profile was skipped", async () => {
  child.batchTriggerAndWait.mockResolvedValue({
    runs: [{ ok: true, output: { status: "skipped" } }],
  });
  mockQuery.mockResolvedValue([]);
  await expect(
    parent.run({ ...parentPayload, userIds: ["user-1"] }, taskOptions),
  ).rejects.toThrow("User research analysis failed");
  expect(generateText).not.toHaveBeenCalled();
});

it("does not weaken the comparison-group minimum after exclusions", async () => {
  child.batchTriggerAndWait.mockResolvedValue({ runs: [] });
  mockQuery.mockResolvedValue([{ pseudonym: "U01", profile, coverage: {} }]);
  await expect(
    parent.run(
      {
        ...parentPayload,
        userIds: ["user-1", "user-2", "user-3", "user-4", "user-5", "user-6"],
        comparisonGroups: [
          { label: "A", userIds: ["user-1", "user-2", "user-3"] },
          { label: "B", userIds: ["user-4", "user-5", "user-6"] },
        ],
      },
      taskOptions,
    ),
  ).rejects.toThrow("User research analysis failed");
  expect(generateText).not.toHaveBeenCalled();
});

it("reports a profile with no structured output and fails without saving it", async () => {
  mockQuery
    .mockResolvedValueOnce([
      { chatId: "chat-1", updatedAt: 1, mode: "ask", truncated: false },
    ])
    .mockResolvedValueOnce({
      messages: [{ role: "user", text: "Synthetic question about a lab" }],
      truncated: false,
    });
  const [xaiModel, bedrockModel] = useNoOutputModel();

  const run = child.run(workerPayload, taskOptions);

  await expect(run).rejects.toThrow(NoOutputGeneratedError);
  expect(xaiModel.doGenerateCalls).toHaveLength(1);
  expect(bedrockModel.doGenerateCalls).toHaveLength(1);
  expect(myProvider.languageModel).toHaveBeenNthCalledWith(
    2,
    "model-grok-4.6-bedrock",
  );
  expect(mockMutation).not.toHaveBeenCalled();
  expect(phLogger.event).toHaveBeenCalledTimes(2);
  expect((phLogger.event as jest.Mock).mock.calls[1][1]).toMatchObject({
    configured_model_key: "model-grok-4.6-bedrock",
  });
  const [name, fields] = (phLogger.event as jest.Mock).mock.calls[0];
  expect(name).toBe("user_research_structured_output_failed");
  expect(fields).toEqual({
    diagnostic_version: 1,
    operation: "profile",
    finish_reason: "length",
    input_tokens: 900,
    output_tokens: 6_000,
    total_tokens: 6_900,
    reasoning_tokens: 6_000,
    configured_model_key: "model-grok-4.6",
    openrouter_generation_id: "gen-1731600000-Synthetic01",
    trigger_run_id: "run_06gt0000000000000000000001",
    trigger_attempt_number: 1,
    trigger_deployment_version: "20261114.1",
  });
  expect(JSON.stringify(fields)).not.toMatch(/user-1|U01|Synthetic question/);
  expect(phLogger.flush).toHaveBeenCalledTimes(2);
});

it("reports a synthesis with no structured output and keeps the run failed", async () => {
  child.batchTriggerAndWait.mockResolvedValue({
    runs: [{ ok: true, output: { status: "completed" } }],
  });
  mockQuery.mockResolvedValue([
    {
      pseudonym: "U01",
      profile,
      coverage: {
        chatsReviewed: 1,
        messagesReviewed: 2,
        askChats: 1,
        agentChats: 0,
      },
    },
  ]);
  const [xaiModel, bedrockModel] = useNoOutputModel();

  await expect(parent.run(parentPayload, taskOptions)).rejects.toThrow(
    "User research analysis failed",
  );
  expect(xaiModel.doGenerateCalls).toHaveLength(1);
  expect(bedrockModel.doGenerateCalls).toHaveLength(1);
  expect(phLogger.event).toHaveBeenCalledWith(
    "user_research_structured_output_failed",
    expect.objectContaining({
      operation: "synthesis",
      finish_reason: "length",
    }),
  );
  const mutationArgs = mockMutation.mock.calls.map(([, args]) => args);
  expect(mutationArgs).not.toContainEqual(
    expect.objectContaining({ report: expect.anything() }),
  );
  expect(mutationArgs.at(-1)).toEqual(
    expect.objectContaining({
      error: "Analysis failed before a privacy-safe cohort report was produced",
    }),
  );
});

describe("prompt privacy guard diagnostics", () => {
  const canary = "syntheticPrivateCanary7f3a";
  const guardError = new Error(
    "Research prompt contains unredacted secret material",
  );
  // Chat metadata is serialized without text sanitization, so it reaches the
  // real guard through the real prompt builder without altering the sanitizer.
  const mockUnsafeProfileEvidence = () =>
    mockQuery
      .mockResolvedValueOnce([
        {
          chatId: "chat-1",
          updatedAt: 1,
          mode: "agent",
          selectedModel: `Bearer ${canary}`,
          truncated: false,
        },
      ])
      .mockResolvedValueOnce({
        messages: [{ role: "user", text: "Synthetic question about a lab" }],
        truncated: false,
      });
  const expectNoPrivateContentInWarnings = () => {
    const serialized = JSON.stringify(
      (triggerLogger.warn as jest.Mock).mock.calls,
    );
    for (const value of [
      canary,
      "Bearer ",
      "eyJ",
      workerPayload.question,
      workerPayload.analysisId,
      "Synthetic question",
      "user-1",
      "U01",
      "Test sample",
      guardError.message,
      "stack",
      "chat-1",
    ]) {
      expect(serialized).not.toContain(value);
    }
  };

  it("rejects an unsafe profile prompt before any model call with a closed warning", async () => {
    mockUnsafeProfileEvidence();

    await expect(child.run(workerPayload, taskOptions)).rejects.toThrow(
      guardError,
    );
    expect(myProvider.languageModel).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(mockMutation).not.toHaveBeenCalled();
    expect((triggerLogger.warn as jest.Mock).mock.calls).toEqual([
      [
        "[user-research] prompt privacy guard rejected",
        { diagnostic_version: 1, operation: "profile", category: "bearer" },
      ],
    ]);
    expectNoPrivateContentInWarnings();
  });

  it("keeps the profile guard error when the warning itself fails", async () => {
    mockUnsafeProfileEvidence();
    (triggerLogger.warn as jest.Mock).mockImplementationOnce(() => {
      throw new Error("log transport failed");
    });

    await expect(child.run(workerPayload, taskOptions)).rejects.toThrow(
      guardError,
    );
    expect(triggerLogger.warn).toHaveBeenCalledTimes(1);
    expect(generateText).not.toHaveBeenCalled();
    expect(mockMutation).not.toHaveBeenCalled();
  });

  it("rejects an unsafe synthesis prompt before any model call and fails the run", async () => {
    child.batchTriggerAndWait.mockResolvedValue({
      runs: [{ ok: true, output: { status: "completed" } }],
    });
    // Stored profiles are compacted into the cohort prompt without re-running
    // the text sanitizer, so a synthetic token here reaches the real guard.
    mockQuery.mockResolvedValue([
      {
        pseudonym: "U01",
        profile: { ...profile, summary: `eyJ${canary}.payload.signature` },
        coverage: {
          chatsReviewed: 1,
          messagesReviewed: 2,
          askChats: 1,
          agentChats: 0,
        },
      },
    ]);

    await expect(parent.run(parentPayload, taskOptions)).rejects.toThrow(
      "User research analysis failed",
    );
    expect(myProvider.languageModel).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect((triggerLogger.warn as jest.Mock).mock.calls).toEqual([
      [
        "[user-research] prompt privacy guard rejected",
        { diagnostic_version: 1, operation: "synthesis", category: "jwt" },
      ],
    ]);
    expectNoPrivateContentInWarnings();
    const mutationArgs = mockMutation.mock.calls.map(([, args]) => args);
    expect(mutationArgs).not.toContainEqual(
      expect.objectContaining({ report: expect.anything() }),
    );
    expect(mutationArgs.at(-1)).toEqual(
      expect.objectContaining({
        error:
          "Analysis failed before a privacy-safe cohort report was produced",
      }),
    );
  });
});

describe("model content-filter exclusions", () => {
  const mockProfileEvidence = () =>
    mockQuery
      .mockResolvedValueOnce([
        { chatId: "chat-1", updatedAt: 1, mode: "ask", truncated: false },
      ])
      .mockResolvedValueOnce({
        messages: [{ role: "user", text: "Synthetic question about a lab" }],
        truncated: false,
      });
  const storedProfile = (pseudonym: string) => ({
    pseudonym,
    profile,
    coverage: {
      chatsReviewed: 1,
      messagesReviewed: 2,
      askChats: 1,
      agentChats: 0,
    },
  });

  it("lets Trigger retry a refused profile before the final attempt", async () => {
    mockProfileEvidence();
    useNoOutputModel("content-filter");

    await expect(child.run(workerPayload, taskOptions)).rejects.toThrow(
      ResearchContentFilterError,
    );
    expect(mockMutation).not.toHaveBeenCalled();
  });

  it("reports a profile refused on the final attempt as an explicit exclusion", async () => {
    mockProfileEvidence();
    useNoOutputModel("content-filter");

    await expect(
      child.run(workerPayload, {
        ctx: { ...ctx, attempt: { number: 2 } },
      }),
    ).resolves.toEqual({
      status: "skipped",
      reason: "model_content_filter",
      pseudonym: "U01",
      chatsReviewed: 0,
      messagesReviewed: 0,
    });
    expect(mockMutation).not.toHaveBeenCalled();
    expect(phLogger.event).toHaveBeenCalledWith(
      "user_research_structured_output_failed",
      expect.objectContaining({ finish_reason: "content-filter" }),
    );
  });

  it("saves a profile from Bedrock when xAI's content filter refuses it", async () => {
    mockProfileEvidence();
    useNoOutputModelOnce("content-filter");
    (generateText as jest.Mock).mockResolvedValueOnce({
      output: {
        ...profile,
        userTypes: [
          { type: "bug_bounty_hunter", evidenceCount: 1, confidence: "low" },
        ],
      },
      usage: {},
    });

    await expect(child.run(workerPayload, taskOptions)).resolves.toMatchObject({
      status: "completed",
      pseudonym: "U01",
    });
    expect(myProvider.languageModel).toHaveBeenNthCalledWith(
      2,
      "model-grok-4.6-bedrock",
    );
    // Bedrock keeps zero data retention and never falls back to another host.
    expect(
      (generateText as jest.Mock).mock.calls[1][0].providerOptions.openrouter
        .provider,
    ).toEqual({
      zdr: true,
      only: ["amazon-bedrock"],
      allow_fallbacks: false,
    });
    expect(mockMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pseudonym: "U01", profile: expect.anything() }),
    );
    expect(triggerLogger.warn).toHaveBeenCalledWith(
      "User research retrying on Amazon Bedrock",
      { operation: "profile", contentFilter: true },
    );
  });

  it.each([
    ["refusal text", "I can't help with that."],
    [
      "schema-valid output",
      JSON.stringify({
        ...profile,
        userTypes: [
          { type: "bug_bounty_hunter", evidenceCount: 1, confidence: "low" },
        ],
      }),
    ],
  ])(
    "reports a filtered response with %s on the final attempt as an exclusion",
    async (_label, responseText) => {
      mockProfileEvidence();
      useNoOutputModel("content-filter", responseText);

      await expect(
        child.run(workerPayload, {
          ctx: { ...ctx, attempt: { number: 2 } },
        }),
      ).resolves.toMatchObject({
        status: "skipped",
        reason: "model_content_filter",
      });
      expect(mockMutation).not.toHaveBeenCalled();
    },
  );

  it("counts a stored profile as analyzed even when its task failed", async () => {
    child.batchTriggerAndWait.mockResolvedValue({
      runs: [
        { ok: true, output: { status: "completed" } },
        { ok: false, error: { message: "response lost after save" } },
      ],
    });
    mockQuery.mockResolvedValue([storedProfile("U01"), storedProfile("U02")]);
    (generateText as jest.Mock).mockResolvedValue({
      output: { ...synthesis, avatars: [{ ...synthesis.avatars[0] }] },
      usage: {},
    });

    const result = await parent.run(
      { ...parentPayload, userIds: ["user-1", "user-2"] },
      taskOptions,
    );

    expect(result).toMatchObject({
      usersAnalyzed: 2,
      failedProfiles: 0,
      blockedProfiles: 0,
      excludedUsers: [],
    });
  });

  it("keeps other users' findings and names each excluded user with its reason", async () => {
    child.batchTriggerAndWait.mockResolvedValue({
      runs: [
        { ok: true, output: { status: "completed" } },
        {
          ok: true,
          output: { status: "skipped", reason: "model_content_filter" },
        },
        {
          ok: true,
          output: { status: "skipped", reason: "no_eligible_evidence" },
        },
        { ok: false, error: { message: "fetch failed" } },
      ],
    });
    mockQuery.mockResolvedValue([storedProfile("U01")]);
    (generateText as jest.Mock).mockResolvedValue({
      output: { ...synthesis, unknowns: ["Model-reported gap"] },
      usage: {},
    });

    const result = await parent.run(
      { ...parentPayload, userIds: ["user-1", "user-2", "user-3", "user-4"] },
      taskOptions,
    );

    expect(result).toMatchObject({
      usersAnalyzed: 1,
      failedProfiles: 2,
      skippedProfiles: 1,
      blockedProfiles: 1,
      excludedUsers: [
        { userId: "user-2", reason: "model_content_filter" },
        { userId: "user-3", reason: "no_eligible_evidence" },
        { userId: "user-4", reason: "profile_failed" },
      ],
      report: {
        coverage: {
          usersRequested: 4,
          usersAnalyzed: 1,
          profilesFailed: 2,
          profilesSkipped: 1,
        },
      },
    });
    expect(result.report.unknowns[0]).toMatch(
      /^1 of 4 requested users were not analyzed because the model's content filter refused/,
    );
    expect(result.report.unknowns).toContain("Model-reported gap");
    expect(pmUserResearchResultSchema.safeParse(result).success).toBe(true);
    expect(mockMutation).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ report: result.report }),
    );
  });

  it("names content-filter exclusions when a comparison group falls below the minimum", async () => {
    child.batchTriggerAndWait.mockResolvedValue({
      runs: [
        { ok: true, output: { status: "completed" } },
        { ok: true, output: { status: "completed" } },
        {
          ok: true,
          output: { status: "skipped", reason: "model_content_filter" },
        },
        { ok: true, output: { status: "completed" } },
        { ok: true, output: { status: "completed" } },
        { ok: true, output: { status: "completed" } },
      ],
    });
    mockQuery.mockResolvedValue(
      ["U01", "U02", "U04", "U05", "U06"].map(storedProfile),
    );

    await expect(
      parent.run(
        {
          ...parentPayload,
          userIds: ["user-1", "user-2", "user-3", "user-4", "user-5", "user-6"],
          comparisonGroups: [
            { label: "A", userIds: ["user-1", "user-2", "user-3"] },
            { label: "B", userIds: ["user-4", "user-5", "user-6"] },
          ],
        },
        taskOptions,
      ),
    ).rejects.toThrow(
      "User research analysis failed [comparison_group_below_minimum].",
    );
    expect(generateText).not.toHaveBeenCalled();
    expect(mockMutation.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        error: expect.stringContaining(
          "1 refused by the model content filter, 0 without eligible evidence, 0 failed",
        ),
      }),
    );
  });

  it.each([undefined, "I can't help with that.", JSON.stringify(synthesis)])(
    "fails with a closed reason when the synthesis itself is refused (text: %s)",
    async (refusalText) => {
      child.batchTriggerAndWait.mockResolvedValue({
        runs: [{ ok: true, output: { status: "completed" } }],
      });
      mockQuery.mockResolvedValue([storedProfile("U01")]);
      useNoOutputModel("content-filter", refusalText);

      await expect(
        parent.run({ ...parentPayload, userIds: ["user-1"] }, taskOptions),
      ).rejects.toThrow(
        "User research analysis failed [synthesis_blocked_by_content_filter].",
      );
      const mutationArgs = mockMutation.mock.calls.map(([, args]) => args);
      expect(mutationArgs).not.toContainEqual(
        expect.objectContaining({ report: expect.anything() }),
      );
    },
  );
});
