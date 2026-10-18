import { ChatSDKError } from "@/lib/errors";
import { generateText, Output } from "ai";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { myProvider, resolveAgentTierToProviderKey } from "@/lib/ai/providers";
import {
  applyExtraction,
  EXTRACTION_PROMPT,
  extractionSchema,
  SourceEvidenceError,
} from "./extract";
import { MAX_SCOPE_TEXT } from "./policy";
import { phLogger } from "@/lib/posthog/server";
import { getProviderUsageRawModelCost } from "@/lib/provider-usage-cost";

// Never log exception text or Zod issues: both can contain scope/model content.
function extractionFailureReason(error: unknown) {
  try {
    if (!(error instanceof Error)) return "non_error";
    if (error.name === "AI_NoOutputGeneratedError")
      return "no_output_generated";
    if (error.name === "AI_NoObjectGeneratedError")
      return "no_object_generated";
    if (error.name === "ZodError") return "invalid_extraction_schema";
    switch (error.message) {
      case "Scope change lacks source evidence":
        return "scope_evidence_missing";
      case "Restriction lacks source evidence":
        return "restriction_evidence_missing";
      case "Scope removal does not match a saved rule":
        return "scope_removal_unmatched";
      default:
        return error instanceof TypeError ? "type_error" : "unclassified";
    }
  } catch {
    // Even an unusual thrown value must not interrupt persisting unavailable.
    return "unclassified";
  }
}

function extractionEvidenceCheck(error: unknown) {
  try {
    const check = error instanceof SourceEvidenceError ? error.check : null;
    if (
      check === "scope_source" ||
      check === "scope_target" ||
      check === "restriction_source" ||
      check === "restriction_text"
    )
      return check;
  } catch {
    // Diagnostic properties must never prevent persisting unavailable state.
  }
  return null;
}

function opaqueUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  )
    ? value
    : null;
}

/** Only request admission calls this. Workers and agent tools cannot propose scope changes. */
async function recordScope(args: {
  userId: string;
  chatId: string;
  messageId: string;
}) {
  const client = getConvexClient();
  const auth = { serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!, ...args };
  const source = await client.mutation(
    api.engagementScopes.beginUserMessage,
    auth,
  );
  if (source.complete) return;
  const current = source.current ?? {
    rules: [],
    restrictions: [],
    clarification: "",
  };
  let policy = { rules: current.rules, restrictions: current.restrictions };
  let clarification = current.clarification;
  let unavailable = false;
  let failureStage: "generation" | "validation" = "generation";
  const extractionSignal = AbortSignal.timeout(20_000);
  try {
    if (source.sourceText.length > MAX_SCOPE_TEXT) {
      clarification =
        "The scope instruction is too long to interpret safely. Shorten the scope details or edit the saved scope.";
    } else if (
      !/^(?:continue|go on|proceed|resume|keep going)[.!\s]*$/i.test(
        source.sourceText.trim(),
      )
    ) {
      const result = await generateText({
        model: myProvider.languageModel(
          resolveAgentTierToProviderKey("hackerai-standard"),
        ),
        system: EXTRACTION_PROMPT,
        prompt: JSON.stringify({
          current: policy,
          clarification,
          userMessage: source.sourceText,
        }),
        output: Output.object({ schema: extractionSchema }),
        temperature: 0,
        maxOutputTokens: 4000,
        maxRetries: 0,
        abortSignal: extractionSignal,
        providerOptions: {
          openrouter: {
            // Like title extraction, this bounded classification needs low reasoning.
            reasoning: { enabled: true, effort: "low" },
            usage: { include: true },
          },
        },
      });
      failureStage = "validation";
      ({ policy, clarification } = applyExtraction(
        policy,
        source.sourceText,
        result.output,
      ));
      phLogger.event("engagement_scope_extracted", {
        userId: args.userId,
        cost_dollars: getProviderUsageRawModelCost(result.usage.raw) ?? 0,
        changed:
          result.output.changes.length > 0 ||
          result.output.restrictions.length > 0,
      });
    }
  } catch (error) {
    // Persist the failure independently of transcript/model state. No raw input in logs.
    unavailable = true;
    console.warn("engagement_scope_extraction_failed", {
      stage: failureStage,
      timedOut: extractionSignal.aborted,
      reason: extractionFailureReason(error),
      evidence_check: extractionEvidenceCheck(error),
      chat_id: opaqueUuid(args.chatId),
      message_id: opaqueUuid(args.messageId),
    });
  }
  const applied = await client.mutation(
    api.engagementScopes.commitUserMessage,
    {
      ...auth,
      expectedRevision: source.revision,
      policy,
      clarification,
      unavailable,
    },
  );
  if (!applied)
    throw new ChatSDKError(
      "bad_request:api",
      "Scope changed while preparing this request. Retry to use the latest saved scope.",
    );
}

/** Keep admission failures actionable without returning internal/provider error text. */
export async function recordUserScope(args: {
  userId: string;
  chatId: string;
  messageId: string;
}) {
  try {
    await recordScope(args);
  } catch (error) {
    if (error instanceof ChatSDKError) throw error;
    throw new ChatSDKError(
      "bad_request:api",
      "The scope update could not be saved. Retry this request or edit the saved scope.",
    );
  }
}

/** Recover the original pending instruction before admitting a later one. Never discard narrowing. */
export async function retryUserScope(args: { userId: string; chatId: string }) {
  try {
    const messageId = await getConvexClient().query(
      api.engagementScopes.getRetrySource,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        ...args,
      },
    );
    if (messageId) await recordUserScope({ ...args, messageId });
  } catch (error) {
    if (error instanceof ChatSDKError) throw error;
    throw new ChatSDKError(
      "bad_request:api",
      "Saved scope could not be recovered. Retry this request or edit the saved scope.",
    );
  }
}
