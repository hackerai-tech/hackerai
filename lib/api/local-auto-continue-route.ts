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

function warn(event: string, fields: Record<string, unknown>) {
  console.warn(
    JSON.stringify({
      level: "warn",
      event,
      service: "hackerai-web",
      ...fields,
    }),
  );
}

type RunningContinuation = { decision: Decision; continuedRunId: string };

/**
 * Stores the user's action and returns the continuations that had already
 * started, or undefined when it was not stored. Never throws.
 */
async function storeUserCancel({
  userId,
  chatId,
  reason,
  actionId,
}: {
  userId: string;
  chatId: string;
  reason: LocalAutoContinueCancelReason;
  /** Stable across the client's retries of one Stop or switch. */
  actionId?: string;
}): Promise<RunningContinuation[] | undefined> {
  let result: Partial<{
    cancelled: Decision[];
    running: RunningContinuation[];
  }> | null;
  try {
    result = await getConvexClient().mutation(
      api.agentLocalAutoContinues.cancelForChat,
      {
        serviceKey: serviceKey(),
        userId,
        chatId,
        reason,
        ...(actionId !== undefined && { actionId }),
      },
    );
  } catch (error) {
    warn("agent_local_auto_continue_cancel_failed", {
      chat_id: chatId,
      reason,
      error: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
  // Stored either way. Read defensively: a Convex deployment older than this
  // route returns only the settled rows, and a send must never fail here.
  const cancelled = Array.isArray(result?.cancelled) ? result.cancelled : [];
  if (cancelled.length)
    await withTelemetry(async (telemetry) => {
      for (const decision of cancelled)
        recordOutcome(telemetry, userId, decision);
    }).catch(() => undefined);
  return Array.isArray(result?.running) ? result.running : [];
}

/**
 * The user acted in a chat before its stopped run continued automatically.
 * Never throws: a failure here must not block the user's own action. Returns
 * whether the cancellation was stored, so a caller whose only record of the
 * action is this write (Stop, an environment switch) can report a failure.
 */
export async function cancelLocalAutoContinuesForChat(args: {
  userId: string;
  chatId: string;
  reason: LocalAutoContinueCancelReason;
}): Promise<boolean> {
  return (await storeUserCancel(args)) !== undefined;
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
// Settling a started run and stopping one are idempotent, so they retry fast.
const FOLLOW_UP_ATTEMPTS = 3;
const FOLLOW_UP_RETRY_BASE_MS = 1_000;

/** Retries `run` until it returns true, for a few quick attempts. */
async function retryQuickly(
  run: () => Promise<boolean>,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= FOLLOW_UP_ATTEMPTS; attempt++) {
    if (await run().catch(() => false)) return true;
    if (attempt < FOLLOW_UP_ATTEMPTS)
      await sleep(FOLLOW_UP_RETRY_BASE_MS * attempt);
  }
  return false;
}

/**
 * Stops one automatic continuation. Only that exact run: the expected run ID
 * makes a retry unable to stop a later one. A 409 means the chat no longer
 * runs it, so there is nothing left to stop.
 */
async function stopStartedRun(
  req: NextRequest,
  cancelAgent: RouteHandler,
  chatId: string,
  runId: string,
  sleep: (ms: number) => Promise<void>,
) {
  let status: number | undefined;
  const stopped = await retryQuickly(async () => {
    status = undefined;
    const response = await cancelAgent(
      internalRequest(req, AGENT_CANCEL_ENDPOINT, {
        chatId,
        expectedTriggerRunId: runId,
      }),
    );
    status = response.status;
    return response.ok || response.status === 409;
  }, sleep);
  if (!stopped)
    warn("agent_local_auto_continue_stop_failed", {
      chat_id: chatId,
      continued_run_id: runId,
      ...(status !== undefined ? { http_status: status } : {}),
    });
  return stopped;
}

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
  settings: ContinuationSettings,
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

type ContinuationSettings = {
  sandboxPreference?: string;
  agentPermissionMode?: string;
  selectedModel?: string;
};

/**
 * A continuation the server had to stop may still run. Recorded once per stop
 * (the event UUID is derived from it), never as a completed stop.
 */
function recordStopFailed(
  telemetry: Telemetry,
  userId: string,
  decision: Decision,
  extra: { reason?: LocalAutoContinueReason; continuedRunId: string },
) {
  telemetry.outcome("stop_failed", {
    ...eventContext(userId, decision),
    ...extra,
  });
}

/**
 * Starts one claimed continuation and settles its claim. A run the user
 * stopped while it started, or one whose start cannot be recorded, is stopped
 * here. If that fails too, it is still the chat's active run, which the chat's
 * own Stop ends; a run the user stopped stays on its row, so the chat keeps
 * showing it (see `getForChat`). No background retry: the user's Stop already
 * reaches it, and a retry could race the user's next run.
 */
async function startClaimed({
  req,
  startAgent,
  cancelAgent,
  sleep,
  userId,
  decision,
  settings,
  telemetry,
}: {
  req: NextRequest;
  startAgent: RouteHandler;
  cancelAgent: RouteHandler;
  sleep: (ms: number) => Promise<void>;
  userId: string;
  decision: Decision;
  settings: ContinuationSettings;
  telemetry: Telemetry;
}) {
  // Idempotent, so a lost response or a transient failure retries with the
  // run already in hand and never starts another one.
  const settle = async (
    result:
      | { continuedRunId: string }
      | { failureReason: "admission_refused" | "start_error" },
  ) => {
    let outcome:
      { cancelled: boolean; reason?: LocalAutoContinueReason } | undefined;
    await retryQuickly(async () => {
      outcome = await getConvexClient().mutation(
        api.agentLocalAutoContinues.settleStart,
        {
          serviceKey: serviceKey(),
          userId,
          stoppedRunId: decision.stoppedRunId,
          ...result,
        },
      );
      return true;
    }, sleep);
    return outcome;
  };

  const started = await startContinuation(
    req,
    startAgent,
    decision,
    settings,
    sleep,
  );
  if (!("runId" in started)) {
    await settle({ failureReason: started.failure });
    recordOutcome(telemetry, userId, {
      ...decision,
      state: "start_failed",
      reason: started.failure,
    });
    return;
  }
  const continuedRunId = started.runId;
  const settled = await settle({ continuedRunId });
  if (settled && !settled.cancelled) {
    recordOutcome(
      telemetry,
      userId,
      { ...decision, state: "started" },
      { continuedRunId },
    );
    return;
  }
  // Unrecorded, a Stop the user pressed while it started would go unseen, so
  // fail closed: stop the run rather than ignore a Stop.
  if (!settled)
    warn("agent_local_auto_continue_settle_failed", {
      chat_id: decision.chatId,
      stopped_run_id: decision.stoppedRunId,
      continued_run_id: continuedRunId,
    });
  const stopped = await stopStartedRun(
    req,
    cancelAgent,
    decision.chatId,
    continuedRunId,
    sleep,
  );
  if (!stopped)
    recordStopFailed(telemetry, userId, decision, {
      reason: settled ? settled.reason : "start_error",
      continuedRunId,
    });
  // A cancelled stop reported its outcome when the user acted.
  else if (!settled)
    recordOutcome(
      telemetry,
      userId,
      { ...decision, state: "start_failed", reason: "start_error" },
      { continuedRunId },
    );
}

/** Pages of one computer's waiting stops read per report, 50 stops each. */
const RETURN_PAGES = 5;

type ReportBody =
  | { action: "return"; connectionId: string }
  | {
      action: "cancel";
      chatId: string;
      reason: Extract<
        LocalAutoContinueCancelReason,
        "environment_switched" | "user_stop"
      >;
      actionId?: string;
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
    (body.reason === "environment_switched" || body.reason === "user_stop") &&
    (body.actionId === undefined ||
      (typeof body.actionId === "string" && IDENTIFIER.test(body.actionId)))
  )
    return {
      action: "cancel",
      chatId: body.chatId,
      reason: body.reason,
      ...(body.actionId !== undefined && { actionId: body.actionId }),
    };
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
      const retry = () =>
        NextResponse.json({ ok: false, retryable: true }, { status: 503 });
      // This write is the only record of a Stop or an environment switch, so
      // the caller must learn when it was not stored and try again.
      const running = await storeUserCancel({
        userId,
        chatId: body.chatId,
        reason: body.reason,
        actionId: body.actionId,
      });
      if (!running) return retry();
      if (!running.length) return NextResponse.json({ ok: true });
      // A continuation that already started would keep running on the
      // computer the user stopped or left. Stop exactly that run; a retry of
      // this request stops it again until it is gone.
      const stopped = await withTelemetry(async (telemetry) => {
        let all = true;
        for (const { decision, continuedRunId } of running) {
          if (
            await stopStartedRun(
              req,
              cancelAgent,
              decision.chatId,
              continuedRunId,
              sleep,
            )
          )
            continue;
          all = false;
          recordStopFailed(telemetry, userId, decision, {
            reason: body.reason,
            continuedRunId,
          });
        }
        return all;
      });
      return stopped ? NextResponse.json({ ok: true }) : retry();
    }

    const convex = getConvexClient();
    // Later pages pass back the first page's bound with its cursor.
    const observe = (cursor: string | null, stoppedAfter?: number) =>
      convex.mutation(api.agentLocalAutoContinues.observeReturn, {
        serviceKey: serviceKey(),
        userId,
        connectionId: body.connectionId,
        cursor,
        ...(stoppedAfter !== undefined && { stoppedAfter }),
      });
    let page = await observe(null);
    if (!page.candidates.length && !page.settled.length && page.isDone)
      return NextResponse.json({ pending: false });

    return withTelemetry(async (telemetry, posthog) => {
      let variant: LocalAutoContinueVariant | undefined | null = null;
      let pending = false;
      // Stops the caller cannot claim yet stay waiting, so read past them.
      for (let pages = 1; ; pages++) {
        for (const decision of page.settled)
          recordOutcome(telemetry, userId, decision);
        for (const { stoppedRunId } of page.candidates) {
          if (variant === null)
            variant = await getLocalAutoContinueVariant(userId, posthog);
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
          await startClaimed({
            req,
            startAgent,
            cancelAgent,
            sleep,
            userId,
            decision,
            settings: claim.settings,
            telemetry,
          });
        }
        if (page.isDone || pages >= RETURN_PAGES) break;
        page = await observe(page.continueCursor, page.stoppedAfter);
      }
      return NextResponse.json({ pending });
    });
  };
