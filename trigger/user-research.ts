import { schemaTask } from "@trigger.dev/sdk";
import { ConvexHttpClient } from "convex/browser";
import { generateText, Output } from "ai";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import { GROK_4_6_SLUG, myProvider } from "@/lib/ai/providers";
import { getProviderUsageRawModelCost } from "@/lib/provider-usage-cost";
import {
  assertResearchPromptIsSafe,
  buildCohortPrompt,
  buildUserProfilePrompt,
  cohortSynthesisSchema,
  normalizeCohortSynthesis,
  normalizeResearchUserProfile,
  pmUserResearchPayloadSchema,
  researchSamplingModeSchema,
  researchUserProfileSchema,
  sanitizeResearchText,
  USER_RESEARCH_MODEL_KEY,
  USER_RESEARCH_MIN_COHORT_SIZE,
  USER_RESEARCH_PROMPT_VERSION,
  USER_RESEARCH_PROVIDER_OPTIONS,
  type ResearchBasis,
  type ResearchCohortReport,
  type ResearchCoverage,
} from "@/lib/research/user-research";

const MAX_MESSAGES_PER_CHAT = 80;

const workerPayloadSchema = z
  .object({
    analysisId: z.uuid(),
    userId: z.string().trim().min(1).max(200),
    pseudonym: z.string().regex(/^U\d{2}$/),
    question: z.string().trim().min(10).max(1_000),
    maxChatsPerUser: z.number().int().min(3).max(20),
    samplingMode: researchSamplingModeSchema,
    evidenceWindowDays: z.number().int().min(1).max(365).optional(),
    evidenceAnchorAt: z.number().int().positive().optional(),
  })
  .superRefine((payload, ctx) => {
    const hasAnyWindow =
      payload.evidenceWindowDays !== undefined ||
      payload.evidenceAnchorAt !== undefined;
    const hasCompleteWindow =
      payload.evidenceWindowDays !== undefined &&
      payload.evidenceAnchorAt !== undefined;
    if (payload.samplingMode === "pre_event" && !hasCompleteWindow) {
      ctx.addIssue({
        code: "custom",
        message: "pre_event workers require a complete evidence window",
        path: ["samplingMode"],
        input: payload.samplingMode,
      });
    } else if (payload.samplingMode === "representative" && hasAnyWindow) {
      ctx.addIssue({
        code: "custom",
        message: "representative workers cannot use an evidence window",
        path: ["samplingMode"],
        input: payload.samplingMode,
      });
    }
  });

export { pmUserResearchPayloadSchema } from "@/lib/research/user-research";

const getResearchClient = () => {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  const serviceKey = process.env.CONVEX_USER_RESEARCH_SERVICE_KEY?.trim();
  if (!convexUrl || !serviceKey) {
    throw new Error(
      "NEXT_PUBLIC_CONVEX_URL and CONVEX_USER_RESEARCH_SERVICE_KEY are required",
    );
  }
  return { client: new ConvexHttpClient(convexUrl), serviceKey };
};

const usageForStorage = (usage: {
  inputTokens?: number;
  outputTokens?: number;
  raw?: unknown;
}) => {
  const costDollars = getProviderUsageRawModelCost(usage.raw);
  return {
    ...(usage.inputTokens ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens ? { outputTokens: usage.outputTokens } : {}),
    ...(costDollars ? { costDollars } : {}),
  };
};

export const analyzeUserResearchProfile = schemaTask({
  id: "analyze-user-research-profile",
  schema: workerPayloadSchema,
  maxDuration: 5 * 60,
  retry: { maxAttempts: 2 },
  machine: { preset: "small-1x" },
  run: async (payload) => {
    const { client, serviceKey } = getResearchClient();
    const chats = await client.query(api.userResearch.listRepresentativeChats, {
      serviceKey,
      analysisId: payload.analysisId,
      userId: payload.userId,
      maxChats: payload.maxChatsPerUser,
    });

    const evidence = (
      await Promise.all(
        chats.map(async (chat) => {
          const excerpt = await client.query(
            api.userResearch.getMessageExcerpt,
            {
              serviceKey,
              analysisId: payload.analysisId,
              userId: payload.userId,
              chatId: chat.chatId,
              maxMessages: MAX_MESSAGES_PER_CHAT,
            },
          );
          return { ...chat, ...excerpt };
        }),
      )
    ).filter((chat) => chat.messages.length > 0);

    if (evidence.length === 0) {
      throw new Error("No eligible message evidence was found for this user");
    }

    const firstActivityAt = evidence.at(0)?.updatedAt;
    const lastActivityAt = evidence.at(-1)?.updatedAt;
    const coverage: ResearchCoverage = {
      chatsReviewed: evidence.length,
      messagesReviewed: evidence.reduce(
        (count, chat) => count + chat.messages.length,
        0,
      ),
      askChats: evidence.filter((chat) => chat.mode === "ask").length,
      agentChats: evidence.filter((chat) => chat.mode === "agent").length,
      samplingMode: payload.samplingMode,
      ...(payload.samplingMode === "pre_event" &&
      payload.evidenceAnchorAt !== undefined &&
      payload.evidenceWindowDays !== undefined
        ? {
            evidenceWindowStartAt:
              payload.evidenceAnchorAt -
              payload.evidenceWindowDays * 24 * 60 * 60 * 1_000,
            evidenceWindowEndAt: payload.evidenceAnchorAt,
          }
        : {}),
      ...(firstActivityAt ? { firstActivityAt } : {}),
      ...(lastActivityAt ? { lastActivityAt } : {}),
      truncatedChats: evidence.filter((chat) => chat.truncated).length,
    };

    const prompt = buildUserProfilePrompt({
      question: payload.question,
      pseudonym: payload.pseudonym,
      evidenceWindow: {
        samplingMode: payload.samplingMode,
        ...(coverage.evidenceWindowStartAt !== undefined
          ? { startAt: coverage.evidenceWindowStartAt }
          : {}),
        ...(coverage.evidenceWindowEndAt !== undefined
          ? { endAt: coverage.evidenceWindowEndAt }
          : {}),
      },
      chats: evidence,
    });
    assertResearchPromptIsSafe(prompt);
    const result = await generateText({
      model: myProvider.languageModel(USER_RESEARCH_MODEL_KEY),
      output: Output.object({ schema: researchUserProfileSchema }),
      providerOptions: USER_RESEARCH_PROVIDER_OPTIONS,
      temperature: 0,
      maxOutputTokens: 6_000,
      maxRetries: 1,
      prompt,
    });
    const profile = normalizeResearchUserProfile(
      result.output,
      coverage.chatsReviewed,
    );
    const usage = usageForStorage(result.usage);

    await client.mutation(api.userResearch.saveUserProfile, {
      serviceKey,
      analysisId: payload.analysisId,
      userId: payload.userId,
      pseudonym: payload.pseudonym,
      profile,
      coverage,
      model: GROK_4_6_SLUG,
      promptVersion: USER_RESEARCH_PROMPT_VERSION,
      ...usage,
    });

    // Do not persist raw messages or the detailed profile in Trigger child
    // outputs. The parent reads the restricted Convex record.
    return {
      pseudonym: payload.pseudonym,
      chatsReviewed: coverage.chatsReviewed,
      messagesReviewed: coverage.messagesReviewed,
    };
  },
});

export const pmUserResearch = schemaTask({
  id: "pm-user-research",
  schema: pmUserResearchPayloadSchema,
  maxDuration: 30 * 60,
  retry: { maxAttempts: 1 },
  machine: { preset: "small-1x" },
  run: async (payload) => {
    const { client, serviceKey } = getResearchClient();
    const analysisId = crypto.randomUUID();
    const evidenceAnchors = new Map(
      (payload.evidenceAnchors ?? []).map((anchor) => [
        anchor.userId,
        anchor.anchorAt,
      ]),
    );
    const selectionLimitations = payload.selectionLimitations
      .map(sanitizeResearchText)
      .filter(Boolean);
    const members = payload.userIds.map((userId, index) => ({
      userId,
      pseudonym: `U${String(index + 1).padStart(2, "0")}`,
      ...(evidenceAnchors.has(userId)
        ? { evidenceAnchorAt: evidenceAnchors.get(userId)! }
        : {}),
    }));

    await client.mutation(api.userResearch.createRun, {
      serviceKey,
      analysisId,
      ...(payload.linearIssueId
        ? { linearIssueId: payload.linearIssueId }
        : {}),
      question: payload.question,
      cohortLabel: payload.cohortLabel,
      requestedBy: payload.requestedBy,
      cohortSource: payload.cohortSource,
      posthogProjectId: payload.posthogProjectId,
      cohortSelectedAt: payload.cohortSelectedAt,
      selectionQueryFingerprint: payload.selectionQueryFingerprint,
      selectionLimitations,
      samplingMode: payload.samplingMode,
      ...(payload.evidenceWindowDays !== undefined
        ? { evidenceWindowDays: payload.evidenceWindowDays }
        : {}),
      members,
      maxChatsPerUser: payload.maxChatsPerUser,
      model: GROK_4_6_SLUG,
      reasoningEnabled:
        USER_RESEARCH_PROVIDER_OPTIONS.openrouter.reasoning.enabled,
      reasoningEffort:
        USER_RESEARCH_PROVIDER_OPTIONS.openrouter.reasoning.effort,
    });
    try {
      await client.mutation(api.userResearch.markRunRunning, {
        serviceKey,
        analysisId,
      });
      const batchResult = await analyzeUserResearchProfile.batchTriggerAndWait(
        members.map(({ userId, pseudonym }) => ({
          payload: {
            analysisId,
            userId,
            pseudonym,
            question: payload.question,
            maxChatsPerUser: payload.maxChatsPerUser,
            samplingMode: payload.samplingMode,
            ...(payload.evidenceWindowDays !== undefined
              ? { evidenceWindowDays: payload.evidenceWindowDays }
              : {}),
            ...(evidenceAnchors.has(userId)
              ? { evidenceAnchorAt: evidenceAnchors.get(userId)! }
              : {}),
          },
        })),
      );
      const failedPseudonyms = batchResult.runs.flatMap((run, index) =>
        run.ok ? [] : [members[index]?.pseudonym ?? `U${index + 1}`],
      );
      if (failedPseudonyms.length > 0) {
        console.warn("Some user research profiles failed", {
          analysisId,
          failedPseudonyms,
        });
      }

      const profiles = await client.query(api.userResearch.listProfiles, {
        serviceKey,
        analysisId,
      });
      if (profiles.length < USER_RESEARCH_MIN_COHORT_SIZE) {
        throw new Error(
          "Fewer than three users had enough evidence for privacy-safe synthesis",
        );
      }

      const researchBasis: ResearchBasis = {
        cohortSource: payload.cohortSource,
        posthogProjectId: payload.posthogProjectId,
        cohortSelectedAt: payload.cohortSelectedAt,
        selectionQueryFingerprint: payload.selectionQueryFingerprint,
        selectionLimitations,
        samplingMode: payload.samplingMode,
        ...(payload.evidenceWindowDays !== undefined
          ? { evidenceWindowDays: payload.evidenceWindowDays }
          : {}),
        // Conversation behavior can explain friction and jobs, but it does not
        // establish the user's causal reason for cancelling.
        causalAttributionConfidence: "low",
      };
      const profilesWithBasis = profiles.map((profile) => ({
        ...profile,
        coverage: {
          ...profile.coverage,
          samplingMode: profile.coverage.samplingMode ?? payload.samplingMode,
        },
      }));
      const prompt = buildCohortPrompt({
        question: payload.question,
        cohortLabel: payload.cohortLabel,
        researchBasis,
        profiles: profilesWithBasis,
      });
      assertResearchPromptIsSafe(prompt);
      const result = await generateText({
        model: myProvider.languageModel(USER_RESEARCH_MODEL_KEY),
        output: Output.object({ schema: cohortSynthesisSchema }),
        providerOptions: USER_RESEARCH_PROVIDER_OPTIONS,
        temperature: 0,
        maxOutputTokens: 8_000,
        maxRetries: 1,
        prompt,
      });
      const synthesis = normalizeCohortSynthesis(
        result.output,
        profiles.length,
      );
      const report: ResearchCohortReport = {
        ...synthesis,
        researchBasis,
        coverage: {
          usersRequested: payload.userIds.length,
          usersAnalyzed: profiles.length,
          profilesFailed: failedPseudonyms.length,
          chatsReviewed: profiles.reduce(
            (count, profile) => count + profile.coverage.chatsReviewed,
            0,
          ),
          messagesReviewed: profiles.reduce(
            (count, profile) => count + profile.coverage.messagesReviewed,
            0,
          ),
        },
      };

      await client.mutation(api.userResearch.completeRun, {
        serviceKey,
        analysisId,
        report,
        model: GROK_4_6_SLUG,
        promptVersion: USER_RESEARCH_PROMPT_VERSION,
        ...usageForStorage(result.usage),
      });

      return {
        analysisId,
        status: "completed" as const,
        userIds: payload.userIds,
        failedProfiles: failedPseudonyms.length,
        usersAnalyzed: profiles.length,
        report,
      };
    } catch (error) {
      console.error("User research run failed", {
        analysisId,
        errorType: error instanceof Error ? error.name : "unknown",
      });
      await client.mutation(api.userResearch.failRun, {
        serviceKey,
        analysisId,
        error:
          "Analysis failed before a privacy-safe cohort report was produced",
      });
      throw new Error(
        "User research analysis failed. Review the restricted Trigger run for diagnostics.",
      );
    }
  },
});
