import { schemaTask } from "@trigger.dev/sdk";
import { ConvexHttpClient } from "convex/browser";
import { generateText, Output } from "ai";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import { DEEPSEEK_V4_FLASH_SLUG, myProvider } from "@/lib/ai/providers";
import { getProviderUsageRawModelCost } from "@/lib/provider-usage-cost";
import {
  buildCohortPrompt,
  buildUserProfilePrompt,
  cohortSynthesisSchema,
  normalizeCohortSynthesis,
  normalizeResearchUserProfile,
  researchUserProfileSchema,
  USER_RESEARCH_MODEL_KEY,
  USER_RESEARCH_PROMPT_VERSION,
  USER_RESEARCH_PROVIDER_OPTIONS,
  type ResearchCohortReport,
  type ResearchCoverage,
} from "@/lib/research/user-research";

const MIN_COHORT_SIZE = 3;
const MAX_COHORT_SIZE = 20;
const DEFAULT_MAX_CHATS_PER_USER = 12;
const MAX_MESSAGES_PER_CHAT = 80;

const workerPayloadSchema = z.object({
  analysisId: z.uuid(),
  userId: z.string().trim().min(1).max(200),
  pseudonym: z.string().regex(/^U\d{2}$/),
  question: z.string().trim().min(10).max(1_000),
  maxChatsPerUser: z.number().int().min(3).max(20),
});

export const pmUserResearchPayloadSchema = z
  .object({
    linearIssueId: z
      .string()
      .trim()
      .regex(/^[A-Z]+-\d+$/),
    question: z.string().trim().min(10).max(1_000),
    cohortLabel: z.string().trim().min(3).max(200),
    userIds: z
      .array(z.string().trim().min(1).max(200))
      .min(MIN_COHORT_SIZE)
      .max(MAX_COHORT_SIZE),
    requestedBy: z.string().trim().min(2).max(100),
    maxChatsPerUser: z
      .number()
      .int()
      .min(3)
      .max(20)
      .default(DEFAULT_MAX_CHATS_PER_USER),
  })
  .superRefine((payload, ctx) => {
    if (new Set(payload.userIds).size !== payload.userIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "userIds must be unique",
        path: ["userIds"],
      });
    }
  });

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
      ...(firstActivityAt ? { firstActivityAt } : {}),
      ...(lastActivityAt ? { lastActivityAt } : {}),
      truncatedChats: evidence.filter((chat) => chat.truncated).length,
    };

    const result = await generateText({
      model: myProvider.languageModel(USER_RESEARCH_MODEL_KEY),
      output: Output.object({ schema: researchUserProfileSchema }),
      providerOptions: USER_RESEARCH_PROVIDER_OPTIONS,
      temperature: 0,
      maxOutputTokens: 6_000,
      maxRetries: 1,
      prompt: buildUserProfilePrompt({
        question: payload.question,
        pseudonym: payload.pseudonym,
        chats: evidence,
      }),
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
      model: DEEPSEEK_V4_FLASH_SLUG,
      promptVersion: USER_RESEARCH_PROMPT_VERSION,
      ...usage,
    });

    // Do not persist raw messages, direct user IDs, or the detailed profile in
    // Trigger child outputs. The parent reads the restricted Convex record.
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
    const members = payload.userIds.map((userId, index) => ({
      userId,
      pseudonym: `U${String(index + 1).padStart(2, "0")}`,
    }));

    await client.mutation(api.userResearch.createRun, {
      serviceKey,
      analysisId,
      linearIssueId: payload.linearIssueId,
      question: payload.question,
      cohortLabel: payload.cohortLabel,
      requestedBy: payload.requestedBy,
      members,
      maxChatsPerUser: payload.maxChatsPerUser,
      model: DEEPSEEK_V4_FLASH_SLUG,
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
      if (profiles.length < MIN_COHORT_SIZE) {
        throw new Error(
          "Fewer than three users had enough evidence for privacy-safe synthesis",
        );
      }

      const result = await generateText({
        model: myProvider.languageModel(USER_RESEARCH_MODEL_KEY),
        output: Output.object({ schema: cohortSynthesisSchema }),
        providerOptions: USER_RESEARCH_PROVIDER_OPTIONS,
        temperature: 0,
        maxOutputTokens: 8_000,
        maxRetries: 1,
        prompt: buildCohortPrompt({
          question: payload.question,
          cohortLabel: payload.cohortLabel,
          profiles,
        }),
      });
      const synthesis = normalizeCohortSynthesis(
        result.output,
        profiles.length,
      );
      const report: ResearchCohortReport = {
        ...synthesis,
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
        model: DEEPSEEK_V4_FLASH_SLUG,
        promptVersion: USER_RESEARCH_PROMPT_VERSION,
        ...usageForStorage(result.usage),
      });

      return {
        analysisId,
        status: "completed" as const,
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
