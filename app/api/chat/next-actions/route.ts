import { after, NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getConvexClient } from "@/lib/db/convex-client";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import {
  enforceRegionalSubscriptionFirst,
  subscriptionFirstCountryFromRequest,
} from "@/lib/experiments/regional-subscription-first.server";
import { createRedisClient } from "@/lib/rate-limit/redis";
import PostHogClient from "@/app/posthog";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import {
  buildPredictionSources,
  NEXT_ACTIONS_FLAG,
  NEXT_ACTIONS_VERSION,
  NEXT_ACTIONS_VALIDATION_VERSION,
  nextActionsRequestSchema,
  type NextActionsBatch,
} from "@/lib/chat/next-actions/contracts";
import { generateNextActions } from "@/lib/chat/next-actions/generate";
import { ChatSDKError } from "@/lib/errors";
import {
  NEXT_ACTIONS_REASON_HEADER,
  type NextActionsDeliveryReason,
} from "@/lib/chat/next-actions/delivery";

export const maxDuration = 20;
const empty = (status = 200, reason?: NextActionsDeliveryReason) =>
  NextResponse.json(
    { suggestions: [] },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(reason && { [NEXT_ACTIONS_REASON_HEADER]: reason }),
      },
    },
  );

const batchResponse = (batch: NextActionsBatch) =>
  batch.validationVersion === NEXT_ACTIONS_VALIDATION_VERSION
    ? NextResponse.json(batch, { headers: { "Cache-Control": "no-store" } })
    : empty(200, "saved_incompatible");
// One generation per completed message, including failed/aborted attempts.
// Redis holds only reservations; validated results are private chat data.
// A fixed per-user hourly budget bounds auxiliary spend.
const RESERVE = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local count = tonumber(redis.call('GET', KEYS[2]) or '0')
if count >= 30 then return 0 end
redis.call('SET', KEYS[1], '1', 'EX', 3600)
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], 3600, 'NX')
return 1`;

export async function POST(req: NextRequest) {
  const posthog = PostHogClient();
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(15_000)]);
  try {
    const { userId, subscription, analyticsAccountCohort } =
      await getUserIDAndPro(req);
    const raw = await req.text();
    if (raw.length > 512) return empty(400, "invalid_request");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return empty(200, "invalid_request");
    }
    const parsed = nextActionsRequestSchema.safeParse(body);
    if (!parsed.success) return empty(400, "invalid_request");
    const { chatId, messageId } = parsed.data;
    if (!posthog) return empty(200, "analytics_unavailable");
    const assignment = await getPostHogFlagWithoutExposure(
      posthog,
      NEXT_ACTIONS_FLAG,
      userId,
      { subscription_tier: subscription },
    );
    const enabled = assignment === true || assignment === "test";
    // A disabled flag is not a randomized control assignment.
    if (!enabled && assignment !== "control") return empty(200, "not_offered");
    const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;
    const convex = getConvexClient(signal);
    const preference = await convex.query(
      api.userCustomization.getPredictionPreferenceForBackend,
      { serviceKey, userId },
    );
    if (!preference.enabled) return empty(200, "preference_disabled");
    const chat = await convex.query(api.chats.getChatById, {
      serviceKey,
      id: chatId,
    });
    if (!chat || chat.user_id !== userId || chat.deletion_started_at)
      return empty(404, "chat_unavailable");
    // Agent persists after its browser finish. The client may retry this read
    // briefly; no reservation/model work occurs until the source is settled.
    const completed =
      chat.finish_reason === "stop" &&
      !chat.active_stream_id &&
      !chat.active_trigger_run_id &&
      !chat.active_agent_approval_pending &&
      !chat.active_agent_user_wait &&
      !chat.canceled_at;
    if (!completed)
      return empty(
        409,
        chat.canceled_at
          ? "source_canceled"
          : chat.active_agent_approval_pending || chat.active_agent_user_wait
            ? "source_waiting"
            : chat.active_stream_id || chat.active_trigger_run_id
              ? "source_active"
              : "source_not_successful",
      );
    const history = await convex.query(api.messages.getMessagesPageForBackend, {
      serviceKey,
      userId,
      chatId,
      paginationOpts: { cursor: null, numItems: 6 },
    });
    if (
      history.page[0]?.id !== messageId ||
      history.page[0]?.role !== "assistant"
    )
      return empty(409, "source_stale");
    // Goal completion is persisted separately from model prose. Do not let a
    // prediction reopen a finished workflow, including an older saved draft.
    const goalAchieved = async () => {
      const answer = await convex.query(api.messages.getLastAssistantMessage, {
        serviceKey,
        userId,
        chatId,
      });
      return (
        answer?.id === messageId &&
        typeof answer.metadata?.goal?.achievedElapsedMs === "number"
      );
    };
    if (await goalAchieved()) return empty(200, "goal_complete");
    const sources = buildPredictionSources(history.page);
    if (
      !sources.some((source) => source.id === messageId && source.text.trim())
    )
      return empty(200, "context_empty");
    const mode = chat.default_model_slug === "ask" ? "ask" : "agent";
    // Enrollment eligibility must be identical in both randomized arms.
    await assertUserCanMakeCostIncurringRequest(userId, { signal });
    await enforceRegionalSubscriptionFirst({
      userId,
      subscription,
      country: subscriptionFirstCountryFromRequest(req),
      surface: mode,
      captureExposure: false,
    });
    const saved = enabled
      ? await convex.query(api.nextActions.getForBackend, {
          serviceKey,
          userId,
          chatId,
          messageId,
        })
      : null;
    if (saved)
      return saved.consumed || !saved.batch
        ? empty(200, "saved_consumed")
        : batchResponse(saved.batch);
    // Returning to a chat only restores existing work; it never spends tokens.
    if (parsed.data.restoreOnly) return empty(200, "restore_miss");
    if (
      !chat.last_run_finished_at ||
      Date.now() - chat.last_run_finished_at > 5 * 60_000
    )
      return empty(200, "source_expired");
    const properties = {
      definition_version: NEXT_ACTIONS_VERSION,
      prompt_version: "task-progress-single-reply-v7",
      draft_validation_version: NEXT_ACTIONS_VALIDATION_VERSION,
      provider_accounting_version: 2,
      flag_key: NEXT_ACTIONS_FLAG,
      experiment_version: "next-actions-v1",
      account_metadata_version: 1,
      account_cohort: analyticsAccountCohort ?? "unknown",
      [`$feature/${NEXT_ACTIONS_FLAG}`]: enabled ? "test" : "control",
      chat_id: chatId,
      message_id: messageId,
      mode,
      subscription_tier: subscription,
      assignment: enabled ? "test" : "control",
      $process_person_profile: false,
    };
    posthog.capture({
      distinctId: userId,
      event: "contextual_next_actions_eligible",
      properties: {
        ...properties,
        $insert_id: `next-actions:${userId}:${messageId}:eligible`,
      },
    });
    if (!enabled) return empty(200, "not_offered");
    const redis = createRedisClient();
    if (!redis) return empty(200, "reservation_unavailable");
    if (
      (await redis.eval(
        RESERVE,
        [
          `next_actions:${userId}:${messageId}`,
          `next_actions_budget:${userId}`,
        ],
        [],
      )) !== 1
    )
      return empty(200, "generation_reserved_or_budgeted");
    const started = Date.now();
    const batchId = crypto.randomUUID();
    let result;
    try {
      result = await generateNextActions(sources, signal);
    } catch {
      posthog.capture({
        distinctId: userId,
        event: "contextual_next_actions_generated",
        properties: {
          ...properties,
          batch_id: batchId,
          outcome: "unavailable",
          latency_ms: Date.now() - started,
        },
      });
      return empty(200, "provider_unavailable");
    }
    posthog.capture({
      distinctId: userId,
      event: "contextual_next_actions_generated",
      properties: {
        ...properties,
        batch_id: batchId,
        outcome: result.unavailable
          ? "unavailable"
          : result.suggestions.length
            ? "generated"
            : "empty",
        suggestion_count: result.suggestions.length,
        latency_ms: Date.now() - started,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        model: result.modelId,
        reasoning_tokens: result.reasoningTokens,
        cost_usd: result.cost,
        known_cost_usd: result.knownCost,
        provider_calls: result.providerCalls,
        priced_provider_calls: result.pricedProviderCalls,
        unknown_provider_calls: result.unknownProviderCalls,
        models: result.modelIds,
      },
    });
    signal.throwIfAborted();
    const latest = await convex.query(api.chats.getChatById, {
      serviceKey,
      id: chatId,
    });
    if (
      !latest ||
      latest.user_id !== userId ||
      latest.deletion_started_at ||
      latest.canceled_at ||
      latest.active_stream_id ||
      latest.active_trigger_run_id ||
      latest.finish_reason !== "stop" ||
      latest.last_run_finished_at !== chat.last_run_finished_at
    )
      return empty(200, "source_changed");
    // Regeneration can delete the answer before a replacement run is admitted,
    // without changing the chat's completion fields.
    const latestHistory = await convex.query(
      api.messages.getMessagesPageForBackend,
      {
        serviceKey,
        userId,
        chatId,
        paginationOpts: { cursor: null, numItems: 1 },
      },
    );
    if (
      latestHistory.page[0]?.id !== messageId ||
      latestHistory.page[0]?.role !== "assistant"
    )
      return empty(200, "source_stale");
    if (!result.suggestions.length)
      return empty(
        200,
        result.unavailable ? "provider_unavailable" : "prediction_empty",
      );
    if (await goalAchieved()) return empty(200, "goal_complete");
    const savedBatch = await convex.mutation(api.nextActions.saveForBackend, {
      serviceKey,
      userId,
      chatId,
      messageId,
      finishedAt: chat.last_run_finished_at,
      batch: {
        batchId,
        messageId,
        mode,
        suggestions: result.suggestions,
        validationVersion: NEXT_ACTIONS_VALIDATION_VERSION,
      },
    });
    return savedBatch ? batchResponse(savedBatch) : empty(200, "save_rejected");
  } catch (error) {
    // Optional predictions never surface provider/auth/data errors or content.
    return empty(
      200,
      req.signal.aborted
        ? "request_aborted"
        : signal.aborted
          ? "server_deadline"
          : error instanceof ChatSDKError && error.type === "unauthorized"
            ? "auth_required"
            : error instanceof ChatSDKError &&
                (error.type === "forbidden" || error.type === "rate_limit")
              ? "access_denied"
              : "server_error",
    );
  } finally {
    // Keep event delivery in the request lifetime without delaying the draft.
    // The 15s request budget leaves room inside maxDuration for this flush.
    if (posthog) after(() => posthog.shutdown(4_000).catch(() => {}));
  }
}

/**
 * Consume optional suggestions with the existing empty-response contract,
 * including auth/data failures; observe one pending stage before hard termination.
 */
export async function DELETE(req: NextRequest) {
  let stage: "authenticate" | "read_request" | "consume" = "authenticate";
  const startedAt = Date.now();
  // The platform's 20s termination can bypass finally; record the pending
  // boundary once beforehand, without delaying or retrying the request.
  const slowTimer = setTimeout(() => {
    try {
      const requestId = req.headers.get("x-vercel-id");
      console.warn(
        JSON.stringify({
          event: "next_actions_delete_slow_request",
          diagnostic_version: 1,
          stage,
          elapsed_ms: Math.max(0, Date.now() - startedAt),
          warning_threshold_ms: 10_000,
          request_aborted: req.signal.aborted,
          ...(requestId &&
          /^(?:[a-z0-9-]{1,32}::){0,2}[a-z0-9]{3,12}-\d{13}-[a-f0-9]{12,64}$/.test(
            requestId,
          )
            ? { request_id: requestId }
            : {}),
        }),
      );
    } catch {
      /* Diagnostics cannot change optional prediction behavior. */
    }
  }, 10_000);
  slowTimer.unref?.();
  try {
    const { userId } = await getUserIDAndPro(req);
    stage = "read_request";
    const raw = await req.text();
    if (raw.length > 512) return empty(400);
    const parsed = nextActionsRequestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return empty(400);
    stage = "consume";
    await getConvexClient(
      AbortSignal.any([req.signal, AbortSignal.timeout(5_000)]),
    ).mutation(api.nextActions.consumeForBackend, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      userId,
      chatId: parsed.data.chatId,
      messageId: parsed.data.messageId,
    });
    return empty();
  } catch {
    return empty();
  } finally {
    clearTimeout(slowTimer);
  }
}
