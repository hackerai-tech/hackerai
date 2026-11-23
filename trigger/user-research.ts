import { logger as triggerLogger, schemaTask } from "@trigger.dev/sdk";
import { createServiceConvexClient } from "@/lib/db/service-client";
import { generateText, Output } from "ai";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import { GROK_4_6_SLUG, myProvider } from "@/lib/ai/providers";
import {
  AMAZON_BEDROCK_ONLY_ROUTING,
  GROK_4_6_BEDROCK_MODEL_KEY,
} from "@/lib/ai/grok-bedrock";
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
  sanitizeResearchComparisonGroups,
  sanitizeResearchText,
  formatResearchRunFailure,
  withContentFilterLimitation,
  USER_RESEARCH_MODEL_KEY,
  USER_RESEARCH_MIN_COHORT_SIZE,
  USER_RESEARCH_MIN_USERS_PER_COMPARISON_GROUP,
  USER_RESEARCH_PROMPT_VERSION,
  USER_RESEARCH_PROVIDER_OPTIONS,
  type ResearchBasis,
  type ResearchCohortReport,
  type ResearchCoverage,
  type ResearchExclusionReason,
  type ResearchPromptSecretCategory,
  type ResearchRunFailureReason,
} from "@/lib/research/user-research";
import {
  isResearchContentFilterRefusal,
  readResearchStructuredOutput,
  type ResearchModelKey,
  type ResearchStructuredOutputOperation,
} from "@/lib/research/structured-output-diagnostics";

const MAX_MESSAGES_PER_CHAT = 80;

type ResearchModelRoute = {
  modelKey: ResearchModelKey;
  providerOptions: Parameters<typeof generateText>[0]["providerOptions"];
};

const XAI_RESEARCH_ROUTE: ResearchModelRoute = {
  modelKey: USER_RESEARCH_MODEL_KEY,
  providerOptions: USER_RESEARCH_PROVIDER_OPTIONS,
};

// Same Grok 4.6 model on Amazon Bedrock, which can answer requests xAI's
// content filter withholds. Zero data retention stays required.
const BEDROCK_RESEARCH_ROUTE: ResearchModelRoute = {
  modelKey: GROK_4_6_BEDROCK_MODEL_KEY,
  providerOptions: {
    openrouter: {
      ...USER_RESEARCH_PROVIDER_OPTIONS.openrouter,
      provider: {
        ...USER_RESEARCH_PROVIDER_OPTIONS.openrouter.provider,
        ...AMAZON_BEDROCK_ONLY_ROUTING,
      },
    },
  },
};

/** Try xAI first; any refusal or failure gets one attempt on Bedrock. */
const generateWithBedrockFallback = async <T>(
  operation: ResearchStructuredOutputOperation,
  generate: (route: ResearchModelRoute) => Promise<T>,
): Promise<T> => {
  try {
    return await generate(XAI_RESEARCH_ROUTE);
  } catch (error) {
    triggerLogger.warn("User research retrying on Amazon Bedrock", {
      operation,
      contentFilter: isResearchContentFilterRefusal(error),
    });
    return generate(BEDROCK_RESEARCH_ROUTE);
  }
};
const PROFILE_MAX_ATTEMPTS = 2;
const GENERIC_RUN_FAILURE =
  "Analysis failed before a privacy-safe cohort report was produced";

/** A cohort failure with a closed reason and a count-only restricted detail. */
class ResearchRunFailure extends Error {
  constructor(
    readonly reason: ResearchRunFailureReason,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "ResearchRunFailure";
  }
}

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
  return { client: createServiceConvexClient(convexUrl), serviceKey };
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

// Failure-only warning with closed fields. Trigger attaches run and attempt
// identity natively; never add the prompt, ctx, or the guard error here.
const warnUnsafeResearchPrompt =
  (operation: ResearchStructuredOutputOperation) =>
  (category: ResearchPromptSecretCategory) => {
    triggerLogger.warn("[user-research] prompt privacy guard rejected", {
      diagnostic_version: 1,
      operation,
      category,
    });
  };

export const analyzeUserResearchProfile = schemaTask({
  id: "analyze-user-research-profile",
  schema: workerPayloadSchema,
  maxDuration: 5 * 60,
  retry: { maxAttempts: PROFILE_MAX_ATTEMPTS },
  machine: { preset: "small-1x" },
  run: async (payload, { ctx }) => {
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
      // An empty eligible sample cannot improve by retrying the same window.
      // Keep it explicit in coverage without fabricating a profile.
      return {
        status: "skipped" as const,
        reason: "no_eligible_evidence" as const,
        pseudonym: payload.pseudonym,
        chatsReviewed: 0,
        messagesReviewed: 0,
      };
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
    assertResearchPromptIsSafe(prompt, warnUnsafeResearchPrompt("profile"));
    const generateProfile = async (route: ResearchModelRoute) => {
      const result = await generateText({
        model: myProvider.languageModel(route.modelKey),
        output: Output.object({ schema: researchUserProfileSchema }),
        providerOptions: route.providerOptions,
        temperature: 0,
        maxOutputTokens: 6_000,
        maxRetries: 1,
        prompt,
      });
      return {
        output: await readResearchStructuredOutput(result, {
          operation: "profile",
          ctx,
          modelKey: route.modelKey,
        }),
        usage: result.usage,
      };
    };
    let generated: Awaited<ReturnType<typeof generateProfile>>;
    try {
      generated = await generateWithBedrockFallback("profile", generateProfile);
    } catch (error) {
      // A refusal can clear on a fresh attempt, so let Trigger retry it. On
      // the final attempt, report an explicit exclusion so the cohort keeps
      // the reason instead of an anonymous task failure.
      if (
        isResearchContentFilterRefusal(error) &&
        ctx.attempt.number >= PROFILE_MAX_ATTEMPTS
      ) {
        return {
          status: "skipped" as const,
          reason: "model_content_filter" as const,
          pseudonym: payload.pseudonym,
          chatsReviewed: 0,
          messagesReviewed: 0,
        };
      }
      throw error;
    }
    const profile = normalizeResearchUserProfile(
      generated.output,
      coverage.chatsReviewed,
    );
    const usage = usageForStorage(generated.usage);

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
      status: "completed" as const,
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
  run: async (payload, { ctx }) => {
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
    const comparisonGroups = sanitizeResearchComparisonGroups(
      payload.comparisonGroups,
    );
    const comparisonGroupByUserId = new Map(
      (comparisonGroups ?? []).flatMap((group) =>
        group.userIds.map((userId) => [userId, group.label] as const),
      ),
    );
    const members = payload.userIds.map((userId, index) => ({
      userId,
      pseudonym: `U${String(index + 1).padStart(2, "0")}`,
      ...(evidenceAnchors.has(userId)
        ? { evidenceAnchorAt: evidenceAnchors.get(userId)! }
        : {}),
      ...(comparisonGroupByUserId.has(userId)
        ? { comparisonGroupLabel: comparisonGroupByUserId.get(userId)! }
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
      // A stored profile is analyzed even if its task later failed or was
      // retried, so each user is either analyzed or excluded, never both.
      // A missing batch entry is a failed profile, never a silent omission.
      const profiles = await client.query(api.userResearch.listProfiles, {
        serviceKey,
        analysisId,
      });
      const availablePseudonyms = new Set(
        profiles.map((profile) => profile.pseudonym),
      );
      const excludedMembers = members.flatMap((member, index) => {
        if (availablePseudonyms.has(member.pseudonym)) return [];
        const run = batchResult.runs[index];
        const reason: ResearchExclusionReason | undefined = !run?.ok
          ? "profile_failed"
          : run.output.status !== "skipped"
            ? undefined
            : run.output.reason === "model_content_filter"
              ? "model_content_filter"
              : "no_eligible_evidence";
        return reason ? [{ ...member, reason }] : [];
      });
      const countExcluded = (reason: ResearchExclusionReason) =>
        excludedMembers.filter((member) => member.reason === reason).length;
      const blockedProfiles = countExcluded("model_content_filter");
      const skippedProfiles = countExcluded("no_eligible_evidence");
      // Content-filter exclusions stay inside the stored failure count, so the
      // persisted report keeps its existing coverage shape.
      const failedProfiles = countExcluded("profile_failed") + blockedProfiles;
      const exclusionDetail = `${blockedProfiles} refused by the model content filter, ${skippedProfiles} without eligible evidence, ${failedProfiles - blockedProfiles} failed`;
      if (excludedMembers.length > 0) {
        console.warn("Some user research profiles were excluded", {
          analysisId,
          excluded: excludedMembers.map(({ pseudonym, reason }) => ({
            pseudonym,
            reason,
          })),
        });
      }

      if (profiles.length < USER_RESEARCH_MIN_COHORT_SIZE) {
        throw new ResearchRunFailure(
          "no_analyzable_profiles",
          `No users could be analyzed (${exclusionDetail})`,
        );
      }
      const comparisonGroupsForPrompt = comparisonGroups?.map((group) => ({
        label: group.label,
        pseudonyms: group.userIds
          .map((userId) => {
            const index = payload.userIds.indexOf(userId);
            return `U${String(index + 1).padStart(2, "0")}`;
          })
          .filter((pseudonym) => availablePseudonyms.has(pseudonym)),
      }));
      if (
        comparisonGroupsForPrompt?.some(
          (group) =>
            group.pseudonyms.length <
            USER_RESEARCH_MIN_USERS_PER_COMPARISON_GROUP,
        )
      ) {
        throw new ResearchRunFailure(
          "comparison_group_below_minimum",
          `Fewer than three users remained in a comparison group for privacy-safe synthesis (${exclusionDetail})`,
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
        ...(comparisonGroups
          ? {
              comparisonGroups: comparisonGroups.map((group) => ({
                label: group.label,
                userCount: group.userIds.length,
              })),
            }
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
        ...(comparisonGroupsForPrompt
          ? { comparisonGroups: comparisonGroupsForPrompt }
          : {}),
        profiles: profilesWithBasis,
      });
      assertResearchPromptIsSafe(prompt, warnUnsafeResearchPrompt("synthesis"));
      const generateSynthesis = async (route: ResearchModelRoute) => {
        const result = await generateText({
          model: myProvider.languageModel(route.modelKey),
          output: Output.object({ schema: cohortSynthesisSchema }),
          providerOptions: route.providerOptions,
          temperature: 0,
          maxOutputTokens: 8_000,
          maxRetries: 1,
          prompt,
        });
        return {
          output: await readResearchStructuredOutput(result, {
            operation: "synthesis",
            ctx,
            modelKey: route.modelKey,
          }),
          usage: result.usage,
        };
      };
      let generated: Awaited<ReturnType<typeof generateSynthesis>>;
      try {
        generated = await generateWithBedrockFallback(
          "synthesis",
          generateSynthesis,
        );
      } catch (error) {
        if (isResearchContentFilterRefusal(error)) {
          throw new ResearchRunFailure(
            "synthesis_blocked_by_content_filter",
            "The model content filter refused the cohort synthesis",
          );
        }
        throw error;
      }
      const synthesis = withContentFilterLimitation(
        normalizeCohortSynthesis(generated.output, profiles.length),
        blockedProfiles,
        payload.userIds.length,
      );
      const report: ResearchCohortReport = {
        ...synthesis,
        researchBasis,
        coverage: {
          usersRequested: payload.userIds.length,
          usersAnalyzed: profiles.length,
          profilesFailed: failedProfiles,
          profilesSkipped: skippedProfiles,
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
        ...usageForStorage(generated.usage),
      });

      return {
        analysisId,
        status: "completed" as const,
        userIds: payload.userIds,
        ...(comparisonGroups ? { comparisonGroups } : {}),
        failedProfiles,
        skippedProfiles,
        blockedProfiles,
        excludedUsers: excludedMembers.map(({ userId, reason }) => ({
          userId,
          reason,
        })),
        usersAnalyzed: profiles.length,
        report,
      };
    } catch (error) {
      const failure = error instanceof ResearchRunFailure ? error : undefined;
      console.error("User research run failed", {
        analysisId,
        errorType: error instanceof Error ? error.name : "unknown",
        ...(failure ? { reason: failure.reason } : {}),
      });
      await client.mutation(api.userResearch.failRun, {
        serviceKey,
        analysisId,
        error: failure?.detail ?? GENERIC_RUN_FAILURE,
      });
      throw new Error(formatResearchRunFailure(failure?.reason));
    }
  },
});
