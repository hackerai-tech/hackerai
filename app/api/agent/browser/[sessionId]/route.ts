import { randomBytes } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { withServiceQueryRecovery } from "@/lib/db/service-query-recovery.node";
import { getUserID } from "@/lib/auth/get-user-id";
import { phLogger } from "@/lib/posthog/server";
import {
  PREVIEW_DEFER_OPEN_PARAM,
  PREVIEW_DEFER_WAIT_PARAM,
  withPreviewClientContext,
} from "@/lib/ai/browser-handoff/preview-activation-diagnostics";
import { checkpointCloudErrorContext } from "@/lib/ai/tools/utils/persistence-failure";
import {
  normalizeBrowserInput,
  normalizeBrowserInputBatch,
} from "@/lib/ai/browser-handoff/input";
import {
  BrowserPreviewRefreshDeferred,
  BrowserPreviewUnavailable,
  type BrowserCaptureFailureContext,
  type BrowserInputFailureContext,
  type BrowserViewportFailureContext,
  captureBrowserFrame,
  connectBrowserSandbox,
  getActiveBrowserSessionName,
  browserPauseFailureContext,
  browserRelayRenewFailureContext,
  browserRelayStopFailureContext,
  browserSessionReadFailureContext,
  browserSandboxIdentityFailureContext,
  getPrivateStreamPort,
  sendBrowserInput,
  resizeBrowserViewport,
  setAgentBrowserPaused,
  startBrowserRelay,
  renewBrowserRelay,
  stopBrowserRelays,
} from "@/lib/ai/browser-handoff/server";

export const maxDuration = 30;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
class BrowserAuthenticationError extends Error {}

async function resolveSession(
  request: NextRequest,
  sessionId: string,
  allowEnded = false,
) {
  let userId: string;
  try {
    userId = await getUserID(request);
  } catch {
    throw new BrowserAuthenticationError();
  }
  if (!serviceKey || !/^[a-f0-9]{32}$/.test(sessionId)) return null;
  const session = await getConvexClient().query(
    api.browserHandoffs.getForBackend,
    {
      serviceKey,
      userId,
      sessionId,
      allowEnded,
    },
  );
  return session ? { session, userId } : null;
}

const unavailable = (error: unknown) => {
  if (error instanceof BrowserPreviewUnavailable) {
    return json({ state: error.state }, error.state === "closed" ? 410 : 503);
  }
  return json({ state: "disconnected" }, 503);
};

type PreviewDeferralReason = "wait" | "open";
type NegotiatedPreviewDeferrals = "neither" | PreviewDeferralReason | "both";

// The OTLP logger caps records at 80 attributes, seven of them supplied by the logger.
const MAX_BROWSER_PREVIEW_LOG_FIELDS = 72;
const BROWSER_PREVIEW_REQUEST_ID =
  /^(?:[a-z0-9-]{1,32}::){0,2}[a-z0-9]{3,12}-\d{13}-[a-f0-9]{12,64}$/;

function recordPreviewPending(
  request: NextRequest,
  reason: PreviewDeferralReason | "setup_only",
) {
  try {
    const requestId = request.headers.get("x-vercel-id");
    if (!requestId || !BROWSER_PREVIEW_REQUEST_ID.test(requestId)) return;
    const build = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
    phLogger.info(
      reason === "setup_only"
        ? "agent_browser_preview_open_pending"
        : "agent_browser_preview_refresh_deferral",
      {
        diagnostic_version: 1,
        reason,
        request_id: requestId,
        ...(build && /^[a-f0-9]{40}$/i.test(build)
          ? { web_build_commit: build.toLowerCase() }
          : {}),
      },
    );
    after(async () => {
      try {
        await phLogger.flush();
      } catch {
        /* Optional delivery cannot alter the response. */
      }
    });
  } catch {
    /* Optional attribution must never change an accepted deferral. */
  }
}

function hasSetupOnlyCaptureEvidence(context?: BrowserCaptureFailureContext) {
  // Older or incomplete packets cannot distinguish setup from a lost browser.
  return (
    context?.capture_stage === "stream_status" &&
    context.capture_error_kind === "command_exit" &&
    context.capture_command_exit_code === 2 &&
    context.capture_precondition_reason === "socket_stat" &&
    context.capture_precondition_error === "missing" &&
    context.capture_wrapper_receipt_version === 1 &&
    context.capture_wrapper_action === "version" &&
    context.capture_wrapper_phase === "completed" &&
    context.capture_wrapper_exit_code === 0 &&
    context.capture_wrapper_session_matches === true &&
    context.capture_wrapper_history_version === 1 &&
    context.capture_wrapper_history_scope === "handoff_root" &&
    context.capture_wrapper_other_cli_completed === false &&
    context.capture_wrapper_option_prefix_completed === false &&
    context.capture_open_receipt_version === 1 &&
    context.capture_open_receipt_status === "not_observed" &&
    context.capture_close_receipt_version === 1 &&
    context.capture_close_receipt_status === "not_observed"
  );
}

type PreviewGetStage =
  | "resolve_session"
  | "connect_sandbox"
  | "read_active_session"
  | "capture_frame"
  | "verify_active_session";

/** One primitive diagnostic per unavailable GET; never retain the private session or frame. */
const unavailableGet = (
  error: unknown,
  stage: PreviewGetStage,
  request: NextRequest,
  sessionId: string | undefined,
  session?: NonNullable<Awaited<ReturnType<typeof resolveSession>>>["session"],
  captureContext?: BrowserCaptureFailureContext,
  negotiatedDeferrals?: NegotiatedPreviewDeferrals,
) => {
  const response = unavailable(error);
  if (response.status !== 503) return response;
  try {
    const state =
      error instanceof BrowserPreviewUnavailable
        ? Object.getOwnPropertyDescriptor(error, "state")?.value
        : undefined;
    const requestId = request.headers.get("x-vercel-id");
    const build = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
    const {
      capture_active_other_command_v1: activeOtherCommand,
      capture_close_proof_failure_v1: closeProofFailure,
      capture_sdk_delivered_exit_progress_v1: deliveredExitProgress,
      ...captureFields
    } = captureContext ?? {};
    const fields = {
      diagnostic_version: 1,
      failure_stage: stage,
      preview_state: state === "loading" ? "loading" : "disconnected",
      failure_kind:
        error instanceof BrowserPreviewUnavailable
          ? "preview_unavailable"
          : error instanceof TypeError
            ? "type_error"
            : error instanceof Error
              ? "other_error"
              : "thrown_value",
      fresh_requested: request.nextUrl.searchParams.get("fresh") === "1",
      ...(stage === "connect_sandbox" &&
        browserSandboxIdentityFailureContext(error)),
      ...((stage === "read_active_session" ||
        stage === "verify_active_session") &&
        browserSessionReadFailureContext(error)),
      ...(stage === "capture_frame" && captureFields),
      web_build_commit:
        build && /^[a-f0-9]{40}$/i.test(build)
          ? build.toLowerCase()
          : "unknown",
      ...(requestId && BROWSER_PREVIEW_REQUEST_ID.test(requestId)
        ? { request_id: requestId }
        : {}),
      ...(sessionId && /^[a-f0-9]{32}$/.test(sessionId)
        ? { browser_session_id: sessionId }
        : {}),
      ...(session && {
        handoff_state: [
          "agent",
          "waiting",
          "claiming",
          "human",
          "recovery",
          "resuming",
          "closed",
        ].includes(session.state)
          ? session.state
          : "unknown",
        run_active:
          typeof session.runActive === "boolean"
            ? session.runActive
            : "unknown",
        ...(/^run_[a-z0-9]{20,40}$/.test(session.runId)
          ? { trigger_run_id: session.runId }
          : {}),
      }),
    };
    const clientFields = withPreviewClientContext(
      fields,
      request.nextUrl.searchParams,
    );
    const logFields = {
      ...clientFields,
      ...(stage === "capture_frame" &&
        negotiatedDeferrals !== undefined &&
        Object.keys(clientFields).length < MAX_BROWSER_PREVIEW_LOG_FIELDS && {
          capture_negotiated_deferrals_v1: negotiatedDeferrals,
        }),
    };
    // The optional fields come from disjoint helper exits and may use only
    // space remaining after baseline and negotiation fields.
    const optionalCaptureField =
      activeOtherCommand === "eval"
        ? { capture_active_other_command_v1: activeOtherCommand }
        : closeProofFailure !== undefined
          ? { capture_close_proof_failure_v1: closeProofFailure }
          : deliveredExitProgress !== undefined
            ? { capture_sdk_delivered_exit_progress_v1: deliveredExitProgress }
            : {};
    phLogger.info("agent_browser_preview_get_unavailable", {
      ...logFields,
      ...(stage === "capture_frame" &&
        Object.keys(logFields).length < MAX_BROWSER_PREVIEW_LOG_FIELDS &&
        optionalCaptureField),
    });
    after(async () => {
      try {
        await phLogger.flush();
      } catch {
        /* Optional delivery cannot alter the response. */
      }
    });
  } catch {
    // Observability must preserve the original unavailable response and retry policy.
  }
  return response;
};

type PreviewPostStage =
  | "resolve_session"
  | "connect_sandbox"
  | "read_active_session"
  | "pause_browser"
  | "verify_active_session"
  | "drain_relays"
  | "read_stream_port"
  | "release_pointer"
  | "capture_frame"
  | "capture_and_relay"
  | "start_relay"
  | "finish_takeover"
  | "save_exit_note"
  | "unpause_browser"
  | "finish_resume"
  | "renew_relay"
  | "send_input"
  | "resize_viewport";

/** Preserve each POST response while recording only finite failure context. */
const unavailablePost = (
  error: unknown,
  stage: PreviewPostStage,
  request: NextRequest,
  sessionId: string | undefined,
  action: unknown,
  session?: NonNullable<Awaited<ReturnType<typeof resolveSession>>>["session"],
  recoveryResponse = false,
  failureDiagnostic?: {
    context?: BrowserCaptureFailureContext;
    frameAgeExceeded?: boolean;
    inputContext?: BrowserInputFailureContext;
    viewportContext?: BrowserViewportFailureContext;
  },
) => {
  const response = recoveryResponse
    ? json({ state: "recovery" }, 503)
    : unavailable(error);
  if (response.status !== 503) return response;
  try {
    const state =
      error instanceof BrowserPreviewUnavailable
        ? Object.getOwnPropertyDescriptor(error, "state")?.value
        : undefined;
    const requestId = request.headers.get("x-vercel-id");
    const build = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
    // TAKE reads the port with one SDK command before its own guards. Reuse
    // the closed SDK projections without labeling this failure a renewal.
    let streamPortContext: Record<string, unknown> | undefined;
    if (action === "take" && stage === "read_stream_port") {
      try {
        const cloud = checkpointCloudErrorContext(error);
        const command = browserRelayRenewFailureContext(error);
        streamPortContext = {
          post_stream_port_diagnostic_version: 1,
          post_stream_port_error_kind:
            command.relay_renew_error_kind === "command_exit" ||
            command.relay_renew_error_kind === "timeout"
              ? command.relay_renew_error_kind
              : error instanceof BrowserPreviewUnavailable
                ? "preview_unavailable"
                : cloud.cloud_error_kind,
          post_stream_port_http_status: cloud.cloud_http_status,
          post_stream_port_command_exit_code:
            command.relay_renew_command_exit_code,
          ...(cloud.cloud_type_error_signal === undefined
            ? {}
            : {
                post_stream_port_type_error_signal:
                  cloud.cloud_type_error_signal,
                post_stream_port_transport_code: cloud.cloud_transport_code,
              }),
        };
      } catch {
        // Keep the existing event and response if optional projection fails.
      }
    }
    let relayStopContext = {};
    if (stage === "drain_relays") {
      try {
        relayStopContext = browserRelayStopFailureContext(error);
      } catch {
        // Optional stop diagnostics cannot discard the existing event or response.
      }
    }
    phLogger.info("agent_browser_preview_post_unavailable", {
      diagnostic_version: 1,
      action:
        typeof action === "string" &&
        [
          "exposure",
          "take",
          "resume",
          "release",
          "heartbeat",
          "input",
          "viewport",
        ].includes(action)
          ? action
          : "unknown",
      failure_stage: stage,
      ...(stage === "connect_sandbox" &&
        browserSandboxIdentityFailureContext(error)),
      ...(stage === "capture_frame" && {
        post_capture_diagnostic_version: 1,
        post_capture_context_status: failureDiagnostic?.context
          ? "recorded"
          : failureDiagnostic?.frameAgeExceeded
            ? "frame_age_guard"
            : "not_observed",
        ...failureDiagnostic?.context,
      }),
      ...((stage === "release_pointer" || stage === "send_input") && {
        post_input_diagnostic_version: 1,
        post_input_context_status: failureDiagnostic?.inputContext
          ? "recorded"
          : "not_observed",
        ...failureDiagnostic?.inputContext,
      }),
      ...(action === "viewport" &&
        stage === "resize_viewport" &&
        failureDiagnostic?.viewportContext),
      ...streamPortContext,
      ...relayStopContext,
      ...(action === "take" &&
        stage === "pause_browser" &&
        browserPauseFailureContext(error)),
      ...(action === "heartbeat" && stage === "renew_relay"
        ? browserRelayRenewFailureContext(error)
        : {}),
      preview_state: recoveryResponse
        ? "recovery"
        : state === "loading"
          ? "loading"
          : "disconnected",
      failure_kind:
        error instanceof BrowserPreviewUnavailable
          ? "preview_unavailable"
          : error instanceof TypeError
            ? "type_error"
            : error instanceof Error
              ? "other_error"
              : "thrown_value",
      web_build_commit:
        build && /^[a-f0-9]{40}$/i.test(build)
          ? build.toLowerCase()
          : "unknown",
      ...(requestId &&
      /^(?:[a-z0-9-]{1,32}::){0,2}[a-z0-9]{3,12}-\d{13}-[a-f0-9]{12,64}$/.test(
        requestId,
      )
        ? { request_id: requestId }
        : {}),
      ...(sessionId && /^[a-f0-9]{32}$/.test(sessionId)
        ? { browser_session_id: sessionId }
        : {}),
      ...(session && {
        handoff_state: [
          "agent",
          "waiting",
          "claiming",
          "human",
          "recovery",
          "resuming",
          "closed",
        ].includes(session.state)
          ? session.state
          : "unknown",
        run_active:
          typeof session.runActive === "boolean"
            ? session.runActive
            : "unknown",
        ...(/^run_[a-z0-9]{20,40}$/.test(session.runId)
          ? { trigger_run_id: session.runId }
          : {}),
      }),
    });
    after(async () => {
      try {
        await phLogger.flush();
      } catch {
        /* Optional delivery cannot alter the response. */
      }
    });
  } catch {
    /* Keep input, grants, notes, session names, frames and raw errors private. */
  }
  return response;
};

export const GET = withServiceQueryRecovery(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  let resolved: Awaited<ReturnType<typeof resolveSession>>;
  let sessionId: string | undefined;
  let stage: PreviewGetStage = "resolve_session";
  let captureContext: BrowserCaptureFailureContext | undefined;
  let negotiatedDeferrals: NegotiatedPreviewDeferrals | undefined;
  try {
    sessionId = (await params).sessionId;
    resolved = await resolveSession(request, sessionId);
  } catch (error) {
    return error instanceof BrowserAuthenticationError
      ? json({ state: "unauthorized" }, 401)
      : unavailableGet(error, stage, request, sessionId);
  }
  if (!resolved) return json({ state: "expired" }, 404);
  try {
    stage = "connect_sandbox";
    const sandbox = await connectBrowserSandbox(resolved.session);
    stage = "read_active_session";
    const browserSessionName = await getActiveBrowserSessionName(
      sandbox,
      resolved.session,
    );
    if (
      resolved.session.state === "human" &&
      resolved.session.controlledSessionName !== browserSessionName
    )
      return json({ state: "stale" }, 409);
    const query = request.nextUrl.searchParams;
    const fresh = query.get("fresh") === "1";
    const passiveAgentRefresh =
      fresh &&
      resolved.session.state === "agent" &&
      resolved.session.runActive === true;
    const optedIn = (param: string) => {
      const values = query.getAll(param);
      return values.length === 1 && values[0] === "1";
    };
    const deferDuringWait =
      passiveAgentRefresh && optedIn(PREVIEW_DEFER_WAIT_PARAM);
    const deferDuringOpen =
      passiveAgentRefresh && optedIn(PREVIEW_DEFER_OPEN_PARAM);
    negotiatedDeferrals = deferDuringOpen
      ? deferDuringWait
        ? "both"
        : "open"
      : deferDuringWait
        ? "wait"
        : "neither";
    stage = "capture_frame";
    let frame: Awaited<ReturnType<typeof captureBrowserFrame>> | undefined;
    let deferralReason: PreviewDeferralReason | undefined;
    let setupOnly = false;
    try {
      frame = await captureBrowserFrame(
        sandbox,
        resolved.session,
        browserSessionName,
        fresh,
        undefined,
        (context) => {
          captureContext = context;
        },
        {
          recognizeClosed: true,
          observeStatusProgress: true,
          ...(deferDuringWait && { deferDuringWait: true }),
          ...(deferDuringOpen && { deferDuringOpen: true }),
        },
      );
    } catch (error) {
      if (error instanceof BrowserPreviewRefreshDeferred) {
        const allowed =
          error.reason === "open"
            ? deferDuringOpen
            : error.reason === "wait" && deferDuringWait;
        if (!allowed) throw error;
        deferralReason = error.reason;
      } else {
        if (
          fresh ||
          resolved.session.state !== "agent" ||
          resolved.session.runActive !== true ||
          (error instanceof BrowserPreviewUnavailable &&
            error.state === "closed") ||
          !hasSetupOnlyCaptureEvidence(captureContext)
        )
          throw error;
        setupOnly = true;
      }
    }
    stage = "verify_active_session";
    if (
      (await getActiveBrowserSessionName(sandbox, resolved.session)) !==
      browserSessionName
    )
      return json({ state: "stale" }, 409);
    if (setupOnly) {
      recordPreviewPending(request, "setup_only");
      return json({ state: "loading" }, 202);
    }
    if (frame === undefined) {
      const response = json(
        {
          state: resolved.session.state,
          refreshDeferred: true,
          ...(deferralReason === "open" && { refreshDeferredReason: "open" }),
        },
        202,
      );
      if (deferralReason) recordPreviewPending(request, deferralReason);
      return response;
    }
    return json({ state: resolved.session.state, frame, now: Date.now() });
  } catch (error) {
    const session = resolved.session;
    const activeSessionRead =
      (stage === "read_active_session" || stage === "verify_active_session") &&
      request.nextUrl.searchParams.get("fresh") === "1"
        ? browserSessionReadFailureContext(error)
        : undefined;
    const missingActiveSession =
      activeSessionRead?.active_session_read_diagnostic_version === 1 &&
      activeSessionRead.active_session_read_error_kind === "file_not_found";
    const missingFreshFrame =
      stage === "capture_frame" &&
      captureContext?.capture_stage === "fresh_read" &&
      captureContext.capture_fresh_read_diagnostic_version === 1 &&
      captureContext.capture_fresh_read_phase === "sdk_read" &&
      captureContext.capture_fresh_read_error_kind === "file_not_found";
    if (
      (missingActiveSession || missingFreshFrame) &&
      session.state === "agent" &&
      session.runActive === true &&
      serviceKey &&
      request.signal &&
      !request.signal.aborted
    ) {
      // Owner cleanup can remove the selection or frame before the close is visible.
      // Only the existing ownership-scoped query can confirm that close.
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(1_500),
      ]);
      try {
        const current = await getConvexClient(signal).query(
          api.browserHandoffs.getForBackend,
          {
            serviceKey,
            userId: resolved.userId,
            sessionId: session.sessionId,
            allowEnded: true,
          },
        );
        if (
          !signal.aborted &&
          current?.state === "closed" &&
          current.runActive === false &&
          current.sessionId === session.sessionId &&
          current.runId === session.runId &&
          current.userId === resolved.userId
        ) {
          return json({ state: "closed" }, 410);
        }
      } catch {
        // Retain the original capture failure if closure cannot be confirmed.
      }
    }
    return unavailableGet(
      error,
      stage,
      request,
      sessionId,
      resolved.session,
      captureContext,
      negotiatedDeferrals,
    );
  }
});

type BrowserAction = {
  action?: unknown;
  browserSessionName?: unknown;
  grant?: unknown;
  input?: unknown;
  inputs?: unknown;
  width?: unknown;
  height?: unknown;
  requestId?: unknown;
  note?: unknown;
};

/**
 * Apply authenticated browser controls with the existing grant, rollback and
 * response contracts. Failure telemetry uses the resolved session snapshot;
 * it never rereads ownership or records private control payloads.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const processingStartedAt = performance.now();
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin)
    return json({ error: "Invalid origin" }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ error: "JSON required" }, 415);
  let body: BrowserAction;
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 10_000)
      return json({ error: "Input too large" }, 413);
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "Invalid input" }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 10_000) {
          void reader.cancel().catch(() => undefined);
          return json({ error: "Input too large" }, 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    body = JSON.parse(
      new TextDecoder().decode(Buffer.concat(chunks)),
    ) as BrowserAction;
  } catch {
    return json({ error: "Invalid input" }, 400);
  }
  if (!body || typeof body !== "object")
    return json({ error: "Invalid input" }, 400);
  let resolved: Awaited<ReturnType<typeof resolveSession>>;
  let sessionId: string | undefined;
  let stage: PreviewPostStage = "resolve_session";
  try {
    sessionId = (await params).sessionId;
    resolved = await resolveSession(
      request,
      sessionId,
      body.action === "resume",
    );
  } catch (error) {
    return error instanceof BrowserAuthenticationError
      ? json({ error: "Unauthorized" }, 401)
      : unavailablePost(error, stage, request, sessionId, body.action);
  }
  if (!resolved || !serviceKey) return json({ state: "expired" }, 404);
  const { session, userId } = resolved;
  const scope = { serviceKey, userId, sessionId: session.sessionId };
  const convex = getConvexClient();

  if (body.action === "exposure") {
    const first = await convex.mutation(
      api.browserHandoffs.markExposedForBackend,
      scope,
    );
    if (first) {
      phLogger.event("agent_browser_preview_exposed", {
        userId,
        chat_id: session.chatId,
        trigger_run_id: session.runId,
        agent_id: session.agentId,
      });
      after(() => phLogger.flush());
    }
    return json({ ok: true });
  }

  if (body.action === "take") {
    if (
      !["agent", "waiting", "recovery"].includes(session.state) ||
      typeof body.browserSessionName !== "string" ||
      body.browserSessionName.length > 80
    )
      return json({ state: "stale" }, 409);
    const grant = randomBytes(32).toString("base64url");
    const wasPaused = session.state === "recovery";
    const claimed = await convex.mutation(
      api.browserHandoffs.beginTakeoverForBackend,
      {
        ...scope,
        grant,
      },
    );
    if (!claimed) return json({ state: "stale" }, 409);
    let paused = false;
    let captureContext: BrowserCaptureFailureContext | undefined;
    let inputContext: BrowserInputFailureContext | undefined;
    try {
      stage = "connect_sandbox";
      const sandbox = await connectBrowserSandbox(session);
      stage = "read_active_session";
      if (
        (await getActiveBrowserSessionName(sandbox, session)) !==
        body.browserSessionName
      )
        throw new BrowserPreviewUnavailable("closed");
      stage = "pause_browser";
      await setAgentBrowserPaused(sandbox, session, true);
      paused = true;
      stage = "verify_active_session";
      if (
        (await getActiveBrowserSessionName(sandbox, session)) !==
        body.browserSessionName
      )
        throw new BrowserPreviewUnavailable("closed");
      // A previous grant may have disconnected while dragging. Drain its
      // accepted input and release the pointer before exposing a new grant.
      stage = "drain_relays";
      await stopBrowserRelays(sandbox, session);
      stage = "read_stream_port";
      const streamPort = await getPrivateStreamPort(
        sandbox,
        session,
        body.browserSessionName,
      );
      stage = "release_pointer";
      await sendBrowserInput(
        sandbox,
        session,
        body.browserSessionName,
        [
          {
            type: "input_mouse",
            eventType: "mouseReleased",
            x: 0,
            y: 0,
            button: "left",
          },
        ],
        streamPort,
        (context) => {
          inputContext = context;
        },
      );
      // Both jobs use the same paused browser. Drain both before rollback so
      // a late relay cannot outlive a failed capture and reopen revoked input.
      stage = "capture_and_relay";
      const [capture, relay] = await Promise.allSettled([
        captureBrowserFrame(
          sandbox,
          session,
          body.browserSessionName,
          true,
          streamPort,
          (context) => {
            captureContext = context;
          },
        ),
        startBrowserRelay(
          sandbox,
          session,
          body.browserSessionName,
          grant,
          origin,
          streamPort,
        ),
      ]);
      if (capture.status === "rejected") {
        stage = "capture_frame";
        throw capture.reason;
      }
      if (relay.status === "rejected") {
        stage = "start_relay";
        throw relay.reason;
      }
      const frame = capture.value;
      const relayUrl = relay.value;
      stage = "finish_takeover";
      const active = await convex.mutation(
        api.browserHandoffs.finishTakeoverForBackend,
        {
          ...scope,
          grant,
          browserSessionName: body.browserSessionName,
        },
      );
      if (!active) throw new BrowserPreviewUnavailable("closed");
      phLogger.event("agent_browser_human_control_started", {
        userId,
        chat_id: session.chatId,
        trigger_run_id: session.runId,
        agent_id: session.agentId,
      });
      after(() => phLogger.flush());
      return json({ state: "human", grant, frame, relayUrl });
    } catch (error) {
      if (paused) {
        try {
          const sandbox = await connectBrowserSandbox(session);
          await stopBrowserRelays(sandbox, session, grant);
          if (!wasPaused) {
            await setAgentBrowserPaused(sandbox, session, false);
            paused = false;
          }
        } catch {
          // Keep the recovery state if the gate cannot be reopened safely.
        }
      }
      await convex.mutation(api.browserHandoffs.abortTakeoverForBackend, {
        ...scope,
        grant,
        paused: paused || wasPaused,
      });
      return unavailablePost(
        error,
        stage,
        request,
        sessionId,
        body.action,
        session,
        false,
        { context: captureContext, inputContext },
      );
    }
  }

  if (body.action === "resume") {
    if (
      typeof body.requestId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(body.requestId) ||
      (body.note !== undefined &&
        (typeof body.note !== "string" || body.note.length > 4000))
    )
      return json({ error: "Invalid handoff note" }, 400);
    const saveNote = () =>
      convex.mutation(api.browserHandoffs.saveExitNoteForBackend, {
        ...scope,
        requestId: body.requestId as string,
        note: (body.note as string | undefined) ?? "",
      });
    if (session.runActive === false || session.state === "agent") {
      try {
        const continuation = await saveNote();
        return json({
          state: session.state,
          restart: !continuation.runActive,
          continuation,
        });
      } catch {
        return json(
          { error: "Could not save the handoff. Please try again." },
          409,
        );
      }
    }
    if (
      typeof body.browserSessionName !== "string" ||
      body.browserSessionName.length > 80
    )
      return json({ error: "A current browser frame is required" }, 400);
    const started = await convex.mutation(
      api.browserHandoffs.beginResumeForBackend,
      {
        ...scope,
        grant: typeof body.grant === "string" ? body.grant : undefined,
      },
    );
    if (!started) return json({ state: "stale" }, 409);
    let unpaused = false;
    let captureContext: BrowserCaptureFailureContext | undefined;
    let inputContext: BrowserInputFailureContext | undefined;
    let captureFrameAgeExceeded = false;
    try {
      stage = "connect_sandbox";
      const sandbox = await connectBrowserSandbox(session);
      stage = "drain_relays";
      await stopBrowserRelays(sandbox, session);
      stage = "read_active_session";
      if (
        (await getActiveBrowserSessionName(sandbox, session)) !==
        body.browserSessionName
      )
        throw new BrowserPreviewUnavailable("closed");
      // Also cover the HTTP fallback and a vanished relay. The resuming state
      // excludes new input until the pointer is released and a frame is fresh.
      stage = "release_pointer";
      await sendBrowserInput(
        sandbox,
        session,
        body.browserSessionName,
        [
          {
            type: "input_mouse",
            eventType: "mouseReleased",
            x: 0,
            y: 0,
            button: "left",
          },
        ],
        undefined,
        (context) => {
          inputContext = context;
        },
      );
      stage = "capture_frame";
      const frame = await captureBrowserFrame(
        sandbox,
        session,
        body.browserSessionName,
        true,
        undefined,
        (context) => {
          captureContext = context;
        },
      );
      if (Date.now() - frame.capturedAt > 15_000) {
        captureFrameAgeExceeded = true;
        throw new BrowserPreviewUnavailable("disconnected");
      }
      stage = "save_exit_note";
      const continuation = await saveNote();
      stage = "unpause_browser";
      await setAgentBrowserPaused(sandbox, session, false);
      unpaused = true;
      stage = "finish_resume";
      const resumed = await convex.mutation(
        api.browserHandoffs.finishResumeForBackend,
        scope,
      );
      if (!resumed) throw new BrowserPreviewUnavailable("disconnected");
      phLogger.event("agent_browser_human_control_resumed", {
        userId,
        chat_id: session.chatId,
        trigger_run_id: session.runId,
        agent_id: session.agentId,
      });
      after(() => phLogger.flush());
      return json({ state: "agent", frame, continuation, restart: false });
    } catch (error) {
      if (unpaused) {
        try {
          const sandbox = await connectBrowserSandbox(session);
          await setAgentBrowserPaused(sandbox, session, true);
        } catch {
          // The grant is revoked, and the stale resuming state blocks takeover.
        }
      }
      await convex
        .mutation(api.browserHandoffs.abortResumeForBackend, scope)
        .catch(() => undefined);
      return unavailablePost(
        error,
        stage,
        request,
        sessionId,
        body.action,
        session,
        false,
        {
          context: captureContext,
          frameAgeExceeded: captureFrameAgeExceeded,
          inputContext,
        },
      );
    }
  }

  if (typeof body.grant !== "string" || body.grant.length < 32)
    return json({ error: "Control grant required" }, 403);
  if (body.action === "release") {
    const released = await convex.mutation(
      api.browserHandoffs.releaseForBackend,
      {
        ...scope,
        grant: body.grant,
      },
    );
    if (released) {
      try {
        stage = "connect_sandbox";
        const sandbox = await connectBrowserSandbox(session);
        stage = "drain_relays";
        await stopBrowserRelays(sandbox, session, body.grant);
      } catch (error) {
        return unavailablePost(
          error,
          stage,
          request,
          sessionId,
          body.action,
          session,
          true,
        );
      }
    }
    return json(
      { state: released ? "recovery" : "stale" },
      released ? 200 : 409,
    );
  }
  if (body.action === "heartbeat") {
    const lease = Date.now() + 25_000;
    const valid = await convex.mutation(
      api.browserHandoffs.assertGrantForBackend,
      {
        ...scope,
        grant: body.grant,
        renew: true,
      },
    );
    if (valid) {
      try {
        stage = "connect_sandbox";
        const sandbox = await connectBrowserSandbox(session);
        stage = "renew_relay";
        await renewBrowserRelay(sandbox, session, body.grant, lease);
      } catch (error) {
        return unavailablePost(
          error,
          stage,
          request,
          sessionId,
          body.action,
          session,
          true,
        );
      }
    }
    return valid
      ? json({
          state: "human",
          leaseValidForMs: Math.max(0, lease - Date.now()),
          processingDurationMs: Math.max(
            0,
            performance.now() - processingStartedAt,
          ),
        })
      : json({ state: "recovery" }, 409);
  }
  if (body.action === "input" || body.action === "viewport") {
    const resizing = body.action === "viewport";
    if (
      resizing &&
      ![body.width, body.height].every(
        (value) =>
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 240 &&
          value <= 2560,
      )
    )
      return json({ error: "Invalid browser viewport" }, 400);
    const events = resizing
      ? []
      : body.inputs !== undefined
        ? normalizeBrowserInputBatch(body.inputs)
        : normalizeBrowserInput(body.input);
    if (!events) return json({ error: "Invalid browser input" }, 400);
    if (!session.controlledSessionName) return json({ state: "recovery" }, 409);
    const inputId = randomBytes(16).toString("hex");
    const valid = await convex.mutation(
      api.browserHandoffs.beginInputForBackend,
      {
        ...scope,
        grant: body.grant,
        inputId,
      },
    );
    if (!valid) return json({ state: "recovery" }, 409);
    let inputContext: BrowserInputFailureContext | undefined;
    let viewportContext: BrowserViewportFailureContext | undefined;
    try {
      stage = "connect_sandbox";
      const sandbox = await connectBrowserSandbox(session);
      stage = "read_active_session";
      if (
        (await getActiveBrowserSessionName(sandbox, session)) !==
        session.controlledSessionName
      )
        return json({ state: "stale" }, 409);
      if (resizing) {
        stage = "resize_viewport";
        const frame = await resizeBrowserViewport(
          sandbox,
          session,
          session.controlledSessionName,
          body.width as number,
          body.height as number,
          (context) => {
            viewportContext = context;
          },
        );
        return json({ frame });
      }
      stage = "send_input";
      await sendBrowserInput(
        sandbox,
        session,
        session.controlledSessionName,
        events,
        undefined,
        (context) => {
          inputContext = context;
        },
      );
      return json({ ok: true });
    } catch (error) {
      return unavailablePost(
        error,
        stage,
        request,
        sessionId,
        body.action,
        session,
        false,
        { inputContext, viewportContext },
      );
    } finally {
      await convex
        .mutation(api.browserHandoffs.finishInputForBackend, {
          ...scope,
          inputId,
        })
        .catch(() => undefined);
    }
  }
  return json({ error: "Unknown action" }, 400);
}
