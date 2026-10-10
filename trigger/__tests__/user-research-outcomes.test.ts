jest.mock("@trigger.dev/sdk", () => ({
  schemaTask: (config: unknown) => ({
    ...(config as object),
    batchTriggerAndWait: jest.fn(),
  }),
}));
jest.mock("ai", () => ({
  generateText: jest.fn(),
  Output: { object: jest.fn() },
}));
jest.mock("@/lib/ai/providers", () => ({
  GROK_4_6_SLUG: "test-model",
  myProvider: { languageModel: jest.fn() },
}));
import { generateText } from "ai";
import { mockMutation, mockQuery } from "@/__mocks__/convex/browser";
import { analyzeUserResearchProfile, pmUserResearch } from "../user-research";
import { pmUserResearchResultSchema } from "@/lib/research/user-research";

const child = analyzeUserResearchProfile as unknown as {
  run: (payload: object) => Promise<unknown>;
  batchTriggerAndWait: jest.Mock;
};
const parent = pmUserResearch as unknown as {
  run: (payload: object) => Promise<any>;
};
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
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it.each([{ chats: [] }, { chats: [{ chatId: "empty", messages: [] }] }])(
  "skips an empty eligible sample without model calls or profile writes: %s",
  async ({ chats }) => {
    mockQuery.mockResolvedValueOnce(chats).mockResolvedValue({ messages: [] });
    await expect(child.run(workerPayload)).resolves.toEqual({
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
  await expect(child.run(workerPayload)).rejects.toThrow("fetch failed");
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
  const result = await parent.run(parentPayload);
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
});

it("still fails synthesis when every profile was skipped", async () => {
  child.batchTriggerAndWait.mockResolvedValue({
    runs: [{ ok: true, output: { status: "skipped" } }],
  });
  mockQuery.mockResolvedValue([]);
  await expect(
    parent.run({ ...parentPayload, userIds: ["user-1"] }),
  ).rejects.toThrow("User research analysis failed");
  expect(generateText).not.toHaveBeenCalled();
});

it("does not weaken the comparison-group minimum after exclusions", async () => {
  child.batchTriggerAndWait.mockResolvedValue({ runs: [] });
  mockQuery.mockResolvedValue([{ pseudonym: "U01", profile, coverage: {} }]);
  await expect(
    parent.run({
      ...parentPayload,
      userIds: ["user-1", "user-2", "user-3", "user-4", "user-5", "user-6"],
      comparisonGroups: [
        { label: "A", userIds: ["user-1", "user-2", "user-3"] },
        { label: "B", userIds: ["user-4", "user-5", "user-6"] },
      ],
    }),
  ).rejects.toThrow("User research analysis failed");
  expect(generateText).not.toHaveBeenCalled();
});
