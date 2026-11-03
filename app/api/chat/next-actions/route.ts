import { NextRequest, NextResponse } from "next/server";
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
  nextActionsRequestSchema,
} from "@/lib/chat/next-actions/contracts";
import { generateNextActions } from "@/lib/chat/next-actions/generate";

export const maxDuration = 20;
const empty = (status = 200) =>
  NextResponse.json(
    { suggestions: [] },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
// One generation per completed message, including failed/aborted attempts. No
// content is cached. A fixed per-user hourly budget bounds auxiliary spend.
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
    const { userId, subscription } = await getUserIDAndPro(req);
    const raw = await req.text();
    if (raw.length > 512) return empty(400);
    const parsed = nextActionsRequestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return empty(400);
    const { chatId, messageId } = parsed.data;
    if (!posthog) return empty();
    const assignment = await getPostHogFlagWithoutExposure(
      posthog,
      NEXT_ACTIONS_FLAG,
      userId,
      { subscription_tier: subscription },
    );
    const enabled = assignment === true || assignment === "test";
    if (assignment === undefined) return empty();
    const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;
    const convex = getConvexClient(signal);
    const chat = await convex.query(api.chats.getChatById, {
      serviceKey,
      id: chatId,
    });
    if (!chat || chat.user_id !== userId || chat.deletion_started_at)
      return empty(404);
    // Agent persists after its browser finish. The client may retry this read
    // briefly; no reservation/model work occurs until the source is settled.
    const completed =
      chat.finish_reason === "stop" &&
      !chat.active_stream_id &&
      !chat.active_trigger_run_id &&
      !chat.active_agent_approval_pending &&
      !chat.canceled_at;
    if (!completed) return empty(409);
    if (
      !chat.last_run_finished_at ||
      Date.now() - chat.last_run_finished_at > 5 * 60_000
    )
      return empty();
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
      return empty(409);
    const sources = buildPredictionSources(history.page);
    if (
      !sources.some((source) => source.id === messageId && source.text.trim())
    )
      return empty();
    const mode = chat.default_model_slug === "ask" ? "ask" : "agent";
    const properties = {
      definition_version: NEXT_ACTIONS_VERSION,
      flag_key: NEXT_ACTIONS_FLAG,
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
    if (!enabled) return empty();
    await assertUserCanMakeCostIncurringRequest(userId, { signal });
    await enforceRegionalSubscriptionFirst({
      userId,
      subscription,
      country: subscriptionFirstCountryFromRequest(req),
      surface: mode,
      captureExposure: false,
    });
    const redis = createRedisClient();
    if (
      !redis ||
      (await redis.eval(
        RESERVE,
        [
          `next_actions:${userId}:${messageId}`,
          `next_actions_budget:${userId}`,
        ],
        [],
      )) !== 1
    )
      return empty();
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
      return empty();
    }
    posthog.capture({
      distinctId: userId,
      event: "contextual_next_actions_generated",
      properties: {
        ...properties,
        batch_id: batchId,
        outcome: result.suggestions.length ? "generated" : "empty",
        suggestion_count: result.suggestions.length,
        latency_ms: Date.now() - started,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_usd: result.cost,
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
      return empty();
    return NextResponse.json(
      { batchId, messageId, mode, suggestions: result.suggestions },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    // Optional predictions never surface provider/auth/data errors or content.
    return empty();
  } finally {
    await posthog?.shutdown().catch(() => {});
  }
}
