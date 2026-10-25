import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { accessLocalWorkspaceFiles } from "@/lib/sandbox/local-workspace-files";
import { resolveProjectExecutionContext } from "@/lib/chat/project-context";
import { NextRequest, NextResponse } from "next/server";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  assertUserCanMakeCostIncurringRequest,
  assertUserCanAccessChatHistory,
} from "@/lib/suspensions";
import { getChatById } from "@/lib/db/actions";
import { ChatSDKError } from "@/lib/errors";
import {
  getPostHogBooleanFlagDecisionForUser,
  phLogger,
} from "@/lib/posthog/server";
import { getExecutionRegionForVercelRequest } from "@/lib/api/trigger-region";
import { CloudWorkspaceUnavailableError } from "@/lib/ai/tools/utils/cloud-workspace-guard";
import { accessCloudWorkspaceFiles } from "@/lib/sandbox/cloud-workspace-files";
import {
  WORKSPACE_FILES_FLAG,
  workspaceRequest,
  WorkspaceFileError,
} from "@/lib/sandbox/workspace-files";

export const maxDuration = 60;
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers });

async function authorize(req: NextRequest, chatId: string) {
  let session;
  try {
    session = await getUserIDAndPro(req);
  } catch {
    throw new WorkspaceFileError("unauthorized", 401);
  }
  await assertUserCanAccessChatHistory(session.userId);
  const chat = await getChatById({ id: chatId });
  if (!chat || chat.user_id !== session.userId || chat.deletion_started_at)
    throw new WorkspaceFileError("not_found", 404);
  const enabled = await getPostHogBooleanFlagDecisionForUser(
    WORKSPACE_FILES_FLAG,
    session.userId,
    undefined,
    { sendFeatureFlagEvents: false },
  );
  if (enabled !== true) throw new WorkspaceFileError("unavailable", 404);
  return { ...session, chat };
}

function failure(error: unknown) {
  if (error instanceof ChatSDKError)
    return json({ error: error.type }, error.statusCode);
  if (error instanceof WorkspaceFileError)
    return json({ error: error.code }, error.status);
  if (error instanceof CloudWorkspaceUnavailableError)
    return json({ error: "recovery_required" }, 409);
  // Provider exceptions can contain request URLs and user paths. Never return or log them.
  return json({ error: "workspace_unavailable" }, 503);
}

export async function GET(req: NextRequest) {
  try {
    const chatId = req.nextUrl.searchParams.get("chatId");
    if (!chatId || chatId.length > 128) return json({ enabled: false }, 400);
    await authorize(req, chatId);
    return json({ enabled: true });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  let userId: string | undefined;
  let action: string | undefined;
  try {
    // Cookie-authenticated actions are same-origin, including explicit resume.
    const origin = req.headers.get("origin");
    if (origin && origin !== req.nextUrl.origin)
      return json({ error: "forbidden" }, 403);
    const text = await req.text();
    if (text.length > 8192) return json({ error: "invalid_request" }, 400);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    const parsed = workspaceRequest.safeParse(body);
    if (!parsed.success) return json({ error: "invalid_request" }, 400);
    const input = parsed.data;
    action = input.action;
    const auth = await authorize(req, input.chatId);
    userId = auth.userId;
    const preference = input.environment ?? auth.chat.sandbox_type ?? "e2b";
    const local = preference !== "e2b" && preference !== "cloud";
    if (!local && auth.subscription === "free")
      return json({ error: "subscription_required" }, 403);
    if (!["status", "list"].includes(input.action) && !input.sandboxId)
      return json({ error: "invalid_request" }, 400);
    await assertUserCanMakeCostIncurringRequest(userId);
    const redis = createRedisClient();
    if (redis) {
      const count = await redis.eval<unknown[], number>(
        "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return n",
        [`workspace_files_rate:${userId}`],
        [],
      );
      if (count > 120) return json({ error: "rate_limited" }, 429);
    }
    let normalizedPreference = preference;
    if (local) {
      const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
      if (!serviceKey)
        throw new WorkspaceFileError("workspace_unavailable", 503);
      normalizedPreference = await getConvexClient().query(
        api.localSandbox.resolveEnvironmentPreferenceForBackend,
        { serviceKey, userId, preference },
      );
    }
    const project = local
      ? await resolveProjectExecutionContext({
          chat: auth.chat,
          userId,
          mode: "agent",
          sandboxPreference: normalizedPreference,
        })
      : {};
    const result = local
      ? await accessLocalWorkspaceFiles(
          userId,
          normalizedPreference,
          input,
          project.workingDirectory,
        )
      : await accessCloudWorkspaceFiles(
          userId,
          getExecutionRegionForVercelRequest(req),
          input,
        );
    phLogger.event("workspace_files_operation", {
      userId,
      action,
      outcome: "success",
      duration_ms: Date.now() - started,
    });
    return json(result);
  } catch (error) {
    if (userId)
      phLogger.event("workspace_files_operation", {
        userId,
        action,
        outcome: "error",
        duration_ms: Date.now() - started,
      });
    return failure(error);
  }
}
