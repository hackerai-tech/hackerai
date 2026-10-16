import { randomBytes } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { getUserID } from "@/lib/auth/get-user-id";
import { phLogger } from "@/lib/posthog/server";
import {
  normalizeBrowserInput,
  normalizeBrowserInputBatch,
} from "@/lib/ai/browser-handoff/input";
import {
  BrowserPreviewUnavailable,
  captureBrowserFrame,
  connectBrowserSandbox,
  getActiveBrowserSessionName,
  sendBrowserInput,
  setAgentBrowserPaused,
  startBrowserRelay,
  renewBrowserRelay,
  stopBrowserRelays,
} from "@/lib/ai/browser-handoff/server";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;

async function resolveSession(
  request: NextRequest,
  sessionId: string,
  allowEnded = false,
) {
  const userId = await getUserID(request);
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  let resolved: Awaited<ReturnType<typeof resolveSession>>;
  try {
    resolved = await resolveSession(request, (await params).sessionId);
  } catch {
    return json({ state: "unauthorized" }, 401);
  }
  if (!resolved) return json({ state: "expired" }, 404);
  try {
    const sandbox = await connectBrowserSandbox(resolved.session);
    const browserSessionName = await getActiveBrowserSessionName(
      sandbox,
      resolved.session,
    );
    if (
      resolved.session.state === "human" &&
      resolved.session.controlledSessionName !== browserSessionName
    )
      return json({ state: "stale" }, 409);
    const frame = await captureBrowserFrame(
      sandbox,
      resolved.session,
      browserSessionName,
    );
    if (
      (await getActiveBrowserSessionName(sandbox, resolved.session)) !==
      browserSessionName
    )
      return json({ state: "stale" }, 409);
    return json({ state: resolved.session.state, frame, now: Date.now() });
  } catch (error) {
    return unavailable(error);
  }
}

type BrowserAction = {
  action?: unknown;
  browserSessionName?: unknown;
  grant?: unknown;
  input?: unknown;
  inputs?: unknown;
  requestId?: unknown;
  note?: unknown;
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin)
    return json({ error: "Invalid origin" }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ error: "JSON required" }, 415);
  let body: BrowserAction;
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 10_000)
      return json({ error: "Input too large" }, 413);
    body = (await request.json()) as BrowserAction;
  } catch {
    return json({ error: "Invalid input" }, 400);
  }
  if (!body || typeof body !== "object")
    return json({ error: "Invalid input" }, 400);
  let resolved: Awaited<ReturnType<typeof resolveSession>>;
  try {
    resolved = await resolveSession(
      request,
      (await params).sessionId,
      body.action === "resume",
    );
  } catch {
    return json({ error: "Unauthorized" }, 401);
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
      !["agent", "recovery"].includes(session.state) ||
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
    try {
      const sandbox = await connectBrowserSandbox(session);
      if (
        (await getActiveBrowserSessionName(sandbox, session)) !==
        body.browserSessionName
      )
        throw new BrowserPreviewUnavailable("closed");
      await setAgentBrowserPaused(sandbox, session, true);
      paused = true;
      if (
        (await getActiveBrowserSessionName(sandbox, session)) !==
        body.browserSessionName
      )
        throw new BrowserPreviewUnavailable("closed");
      const frame = await captureBrowserFrame(
        sandbox,
        session,
        body.browserSessionName,
        true,
      );
      const relayLease = Date.now() + 25_000;
      const active = await convex.mutation(
        api.browserHandoffs.finishTakeoverForBackend,
        {
          ...scope,
          grant,
          browserSessionName: body.browserSessionName,
        },
      );
      if (!active) throw new BrowserPreviewUnavailable("closed");
      const relayUrl = await startBrowserRelay(
        sandbox,
        session,
        body.browserSessionName,
        grant,
        origin,
        relayLease,
      );
      phLogger.event("agent_browser_human_control_started", {
        userId,
        chat_id: session.chatId,
        trigger_run_id: session.runId,
        agent_id: session.agentId,
      });
      after(() => phLogger.flush());
      return json({ state: "human", grant, frame, relayUrl });
    } catch (error) {
      if (paused && !wasPaused) {
        try {
          const sandbox = await connectBrowserSandbox(session);
          await stopBrowserRelays(sandbox, session, grant);
          await setAgentBrowserPaused(sandbox, session, false);
          paused = false;
        } catch {
          // Keep the recovery state if the gate cannot be reopened safely.
        }
      }
      await convex.mutation(api.browserHandoffs.abortTakeoverForBackend, {
        ...scope,
        grant,
        paused: paused || wasPaused,
      });
      return unavailable(error);
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
    try {
      const sandbox = await connectBrowserSandbox(session);
      await stopBrowserRelays(sandbox, session);
      if (
        (await getActiveBrowserSessionName(sandbox, session)) !==
        body.browserSessionName
      )
        throw new BrowserPreviewUnavailable("closed");
      const frame = await captureBrowserFrame(
        sandbox,
        session,
        body.browserSessionName,
        true,
      );
      if (Date.now() - frame.capturedAt > 15_000)
        throw new BrowserPreviewUnavailable("disconnected");
      const continuation = await saveNote();
      await setAgentBrowserPaused(sandbox, session, false);
      unpaused = true;
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
      return unavailable(error);
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
        await stopBrowserRelays(
          await connectBrowserSandbox(session),
          session,
          body.grant,
        );
      } catch {
        return json({ state: "recovery" }, 503);
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
        await renewBrowserRelay(
          await connectBrowserSandbox(session),
          session,
          body.grant,
          lease,
        );
      } catch {
        return json({ state: "recovery" }, 503);
      }
    }
    return json({ state: valid ? "human" : "recovery" }, valid ? 200 : 409);
  }
  if (body.action === "input") {
    const events =
      body.inputs !== undefined
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
    try {
      const sandbox = await connectBrowserSandbox(session);
      if (
        (await getActiveBrowserSessionName(sandbox, session)) !==
        session.controlledSessionName
      )
        return json({ state: "stale" }, 409);
      await sendBrowserInput(
        sandbox,
        session,
        session.controlledSessionName,
        events,
      );
      return json({ ok: true });
    } catch (error) {
      return unavailable(error);
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
