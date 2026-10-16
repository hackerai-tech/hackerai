import { generateText, Output } from "ai";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { myProvider, resolveTierToProviderKey } from "@/lib/ai/providers";
import {
  applyExtraction,
  EXTRACTION_PROMPT,
  extractionSchema,
} from "./extract";
import { MAX_SCOPE_TEXT } from "./policy";
import { phLogger } from "@/lib/posthog/server";
import { getProviderUsageRawModelCost } from "@/lib/provider-usage-cost";

/** Only request admission calls this. Workers and agent tools cannot propose scope changes. */
export async function recordUserScope(args: {
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
          resolveTierToProviderKey("hackerai-standard", "agent"),
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
        abortSignal: AbortSignal.timeout(20_000),
        providerOptions: {
          openrouter: {
            usage: { include: true },
          },
        },
      });
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
  } catch {
    // Persist the failure independently of transcript/model state. No raw input in logs.
    unavailable = true;
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
    throw new Error(
      "Scope changed while preparing this request. Retry to use the latest saved scope.",
    );
}
