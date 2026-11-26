import { NextRequest, NextResponse } from "next/server";
import type { PostHog } from "posthog-node";
import PostHogClient from "@/app/posthog";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import { AUTO_CONTINUE_PROMPT } from "@/lib/chat/agent-auto-continue-policy";
import {
  AGENT_API_ENDPOINT,
  AGENT_CANCEL_ENDPOINT,
} from "@/lib/api/agent-endpoints";
import {
  STOPPED_RUN_ID,
  localAutoContinueMessageId,
  type LocalAutoContinueCancelReason,
  type LocalAutoContinueReason,
  type LocalAutoContinueState,
  type LocalAutoContinueVariant,
} from "@/lib/chat/local-auto-continue";
import {
  createLocalAutoContinueTelemetry,
  getLocalAutoContinueVariant,
  type LocalAutoContinueOutcome,
} from "@/lib/experiments/agent-local-auto-continue.server";

const serviceKey = () => process.env.CONVEX_SERVICE_ROLE_KEY!;

type Telemetry = ReturnType<typeof createLocalAutoContinueTelemetry>;

type Decision = {
  stoppedRunId: string;
  chatId: string;
  state: LocalAutoContinueState;
  reason?: LocalAutoContinueReason;
  stopReason?: string;
  stoppedAt: number;
  variant?: LocalAutoContinueVariant;
};

const eventContext = (userId: string, decision: Decision) => ({
  userId,
  chatId: decision.chatId,
  stoppedRunId: decision.stoppedRunId,
  stopReason: decision.stopReason,
  stoppedAt: decision.stoppedAt,
  variant: decision.variant,
});

function recordOutcome(
  telemetry: Telemetry,
  userId: string,
  decision: Decision,
  extra: { continuedRunId?: string } = {},
) {
  if (decision.state === "awaiting_return" || decision.state === "starting")
    return;
  telemetry.outcome(decision.state as LocalAutoContinueOutcome, {
    ...eventContext(userId, decision),
    reason: decision.reason,
    ...extra,
  });
}

async function withTelemetry<T>(
  run: (telemetry: Telemetry, posthog: PostHog | null) => Promise<T>,
): Promise<T> {
  let posthog: PostHog | null = null;
  try {
    posthog = PostHogClient();
  } catch {
    posthog = null;
  }
  try {
    return await run(createLocalAutoContinueTelemetry(posthog), posthog);
  } finally {
    // Bounded so an analytics outage cannot hold the request.
    await posthog?.shutdown(1000).catch(() => undefined);
  }
}

/**
 * The user acted in a chat before its stopped run continued automatically.
 * Never throws: a failure here must not block the user's own action.
 */
export async function cancelLocalAutoContinuesForChat({
  userId,
  chatId,
  reason,
}: {
  userId: string;
  chatId: string;
  reason: LocalAutoContinueCancelReason;
}) {
  try {
    const cancelled = await getConvexClient().mutation(
      api.agentLocalAutoContinues.cancelForChat,
      { serviceKey: serviceKey(), userId, chatId, reason },
    );
    if (!Array.isArray(cancelled) || !cancelled.length) return;
    await withTelemetry(async (telemetry) => {
      for (const decision of cancelled)
        recordOutcome(telemetry, userId, decision);
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "agent_local_auto_continue_cancel_failed",
        service: "hackerai-web",
        chat_id: chatId,
        reason,
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}

type RouteHandler = (req: NextRequest) => Promise<Response>;

/** A same-user request to another route handler, reusing auth and geo. */
function internalRequest(req: NextRequest, path: string, body: unknown) {
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  // No signal: the continuation must not stop because the reporter left.
  return new NextRequest(new URL(path, req.url), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const START_ATTEMPTS = 3;
const START_RETRY_BASE_MS = 2_000;
// No new attempt after this, so retries fit the route's time budget.
const START_RETRY_WINDOW_MS = 25_000;

/**
 * Starts the claimed continuation through the normal Agent start handler, as
 * a manual Resume does. Transient failures retry with backoff; a 4xx is a
 * final refusal (limits, a busy chat, a lapsed claim). Retries are safe: the
 * hidden message ID is derived from the stopped run, so the handler saves the
 * same message and its dedupe key returns the same Trigger run.
 */
async function startContinuation(
  req: NextRequest,
  startAgent: RouteHandler,
  decision: Decision,
  settings: {
    sandboxPreference?: string;
    agentPermissionMode?: string;
    selectedModel?: string;
  },
  sleep: (ms: number) => Promise<void>,
): Promise<
  | { runId: string }
  | { failure: "admission_refused" | "start_error"; status?: number }
> {
  const body = {
    chatId: decision.chatId,
    messages: [
      {
        id: localAutoContinueMessageId(decision.stoppedRunId),
        role: "user",
        parts: [{ type: "text", text: AUTO_CONTINUE_PROMPT }],
        metadata: { isAutoContinue: true },
      },
    ],
    todos: [],
    isAutoContinue: true,
    localAutoContinue: { stoppedRunId: decision.stoppedRunId },
    ...settings,
  };
  let status: number | undefined;
  const retryUntil = Date.now() + START_RETRY_WINDOW_MS;
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    try {
      const response = await startAgent(
        internalRequest(req, AGENT_API_ENDPOINT, body),
      );
      status = response.status;
      if (response.ok) {
        const { runId } = (await response.json()) as { runId?: unknown };
        if (typeof runId === "string" && STOPPED_RUN_ID.test(runId))
          return { runId };
        return { failure: "start_error", status };
      }
      if (status < 500) return { failure: "admission_refused", status };
    } catch {
      status = undefined;
    }
    if (attempt === START_ATTEMPTS || Date.now() > retryUntil) break;
    await sleep(START_RETRY_BASE_MS * 2 ** (attempt - 1));
  }
  return { failure: "start_error", status };
}

type ReportBody =
  | { action: "return"; connectionId: string }
  | {
      action: "cancel";
      chatId: string;
      reason: Extract<
        LocalAutoContinueCancelReason,
        "environment_switched" | "user_stop"
      >;
    };

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

function parseBody(raw: unknown): ReportBody | undefined {
  if (typeof raw !== "object" || raw === null) return;
  const body = raw as Record<string, unknown>;
  if (
    body.action === "return" &&
    typeof body.connectionId === "string" &&
    IDENTIFIER.test(body.connectionId)
  )
    return { action: "return", connectionId: body.connectionId };
  if (
    body.action === "cancel" &&
    typeof body.chatId === "string" &&
    IDENTIFIER.test(body.chatId) &&
    (body.reason === "environment_switched" || body.reason === "user_stop")
  )
    return { action: "cancel", chatId: body.chatId, reason: body.reason };
}

/**
 * Detection point for HAC-275. The Desktop app calls this whenever its bridge
 * is connected again after an outage, from any page, so a stopped run
 * continues even when its chat is not open. The server decides everything:
 * which stops belong to that exact native session, whether each is still
 * eligible, the experiment arm, the cap, and the single start.
 */
export const createLocalAutoContinuePost =
  ({
    startAgent,
    cancelAgent,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }: {
    startAgent: RouteHandler;
    cancelAgent: RouteHandler;
    sleep?: (ms: number) => Promise<void>;
  }) =>
  async (req: NextRequest): Promise<Response> => {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return new NextResponse("Invalid JSON body", { status: 400 });
    }
    const body = parseBody(raw);
    if (!body) return new NextResponse("Invalid request", { status: 400 });
    let userId: string;
    try {
      ({ userId } = await getUserIDAndPro(req));
    } catch (error) {
      if (error instanceof ChatSDKError)
        return new NextResponse("Unauthorized", { status: 401 });
      throw error;
    }

    if (body.action === "cancel") {
      await cancelLocalAutoContinuesForChat({
        userId,
        chatId: body.chatId,
        reason: body.reason,
      });
      return NextResponse.json({ ok: true });
    }

    const convex = getConvexClient();
    const { candidates, replaced } = await convex.mutation(
      api.agentLocalAutoContinues.observeReturn,
      { serviceKey: serviceKey(), userId, connectionId: body.connectionId },
    );
    if (!candidates.length && !replaced.length)
      return NextResponse.json({ pending: false });

    return withTelemetry(async (telemetry, posthog) => {
      for (const decision of replaced)
        recordOutcome(telemetry, userId, decision);
      if (!candidates.length) return NextResponse.json({ pending: false });
      const variant = await getLocalAutoContinueVariant(userId, posthog);
      let pending = false;
      for (const { stoppedRunId } of candidates) {
        const claim = await convex.mutation(
          api.agentLocalAutoContinues.claimReturn,
          {
            serviceKey: serviceKey(),
            userId,
            stoppedRunId,
            connectionId: body.connectionId,
            ...(variant ? { variant } : {}),
          },
        );
        if (!claim.claimed) {
          pending ||= claim.pending;
          continue;
        }
        const { decision } = claim;
        if (claim.exposed && decision.variant)
          telemetry.exposed({
            ...eventContext(userId, decision),
            variant: decision.variant,
          });
        if (decision.state !== "starting") {
          recordOutcome(telemetry, userId, decision);
          continue;
        }
        const started = await startContinuation(
          req,
          startAgent,
          decision,
          claim.settings,
          sleep,
        );
        const settled = await convex.mutation(
          api.agentLocalAutoContinues.settleStart,
          {
            serviceKey: serviceKey(),
            userId,
            stoppedRunId,
            ...("runId" in started
              ? { continuedRunId: started.runId }
              : { failureReason: started.failure }),
          },
        );
        if ("runId" in started) {
          if (settled.cancelled) {
            // The user stopped it while it was starting.
            await cancelAgent(
              internalRequest(req, AGENT_CANCEL_ENDPOINT, {
                chatId: decision.chatId,
                expectedTriggerRunId: started.runId,
              }),
            ).catch(() => undefined);
            continue;
          }
          recordOutcome(
            telemetry,
            userId,
            { ...decision, state: "started" },
            { continuedRunId: started.runId },
          );
        } else {
          recordOutcome(telemetry, userId, {
            ...decision,
            state: "start_failed",
            reason: started.failure,
          });
        }
      }
      return NextResponse.json({ pending });
    });
  };
