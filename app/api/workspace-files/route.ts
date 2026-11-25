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
import { ChatSDKError, ERROR_SURFACES, ERROR_TYPES } from "@/lib/errors";
import {
  getPostHogBooleanFlagDecisionForUser,
  phLogger,
} from "@/lib/posthog/server";
import { getExecutionRegionForVercelRequest } from "@/lib/api/trigger-region";
import { CloudWorkspaceUnavailableError } from "@/lib/ai/tools/utils/cloud-workspace-guard";
import { accessCloudWorkspaceFiles } from "@/lib/sandbox/cloud-workspace-files";
import {
  WORKSPACE_ACCESS_STEPS,
  WORKSPACE_FILES_FLAG,
  workspaceRequest,
  WorkspaceFileError,
  type WorkspaceAccessProgress,
} from "@/lib/sandbox/workspace-files";

export const maxDuration = 60;
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers });

type Stage =
  | "request"
  | "auth"
  | "history_access"
  | "chat"
  | "feature_flag"
  | "cost_gate"
  | "rate_limit"
  | "environment"
  | "project"
  | "workspace";

/** Carries a fixed diagnostic reason; responses still use only code/status. */
class AuthorizationRejection extends WorkspaceFileError {
  constructor(
    code: string,
    status: number,
    readonly reason: string,
  ) {
    super(code, status);
  }
}

async function authorize(
  req: NextRequest,
  chatId: string,
  progress: { stage: Stage } = { stage: "auth" },
  historyAccess?: Parameters<typeof assertUserCanAccessChatHistory>[1],
) {
  progress.stage = "auth";
  let session;
  try {
    session = await getUserIDAndPro(req);
  } catch {
    throw new AuthorizationRejection("unauthorized", 401, "unauthenticated");
  }
  progress.stage = "history_access";
  await assertUserCanAccessChatHistory(session.userId, historyAccess);
  progress.stage = "chat";
  const chat = await getChatById({ id: chatId });
  if (!chat || chat.user_id !== session.userId || chat.deletion_started_at)
    throw new AuthorizationRejection(
      "not_found",
      404,
      !chat
        ? "chat_missing"
        : chat.user_id !== session.userId
          ? "chat_not_owned"
          : "chat_deleting",
    );
  progress.stage = "feature_flag";
  const enabled = await getPostHogBooleanFlagDecisionForUser(
    WORKSPACE_FILES_FLAG,
    session.userId,
    undefined,
    { sendFeatureFlagEvents: false },
  );
  if (enabled !== true)
    throw new AuthorizationRejection("unavailable", 404, "flag_unavailable");
  return { ...session, chat };
}

// Closed vocabularies only: a rejection log must never carry request values,
// unrecognized property names, identifiers, paths, or provider error text.
const SCHEMA_FIELDS = new Set(Object.keys(workspaceRequest.shape));
const SCHEMA_ISSUE_CODES = new Set([
  "invalid_type",
  "too_big",
  "too_small",
  "invalid_format",
  "not_multiple_of",
  "unrecognized_keys",
  "invalid_union",
  "invalid_key",
  "invalid_element",
  "invalid_value",
  "custom",
]);
const WORKSPACE_ERROR_CODES = new Set([
  "workspace_unavailable",
  "select_environment",
  "workspace_changed",
  "local_reader_unavailable",
  "not_found",
  "invalid_request",
  "unreadable_path",
  "file_too_large",
  "file_changed",
  "directory_too_large",
  "invalid_path",
  "not_file",
]);
const ERROR_NAMES = new Set([
  "TypeError",
  "SyntaxError",
  "RangeError",
  "ZodError",
  "AbortError",
  "TimeoutError",
]);

type Rejection = { reason: string } & Record<string, string | number>;
type WorkspaceAccess = WorkspaceAccessProgress & { reader: "local" | "cloud" };
const ACCESS_STEPS = new Set<string>(WORKSPACE_ACCESS_STEPS);

function logRejection(
  status: number,
  action: string | undefined,
  details: Rejection | (() => Rejection),
) {
  try {
    const fields = typeof details === "function" ? details() : details;
    console.warn(
      JSON.stringify({
        ...fields,
        event: "workspace_files_request_rejected",
        status,
        action,
      }),
    );
  } catch {
    // Diagnostics must preserve the original failure response.
  }
}

function knownAction(body: unknown) {
  const action = workspaceRequest.shape.action.safeParse(
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).action
      : undefined,
  );
  return action.success ? action.data : undefined;
}

function describeSchemaFailure(
  issues: readonly { code: string; path: PropertyKey[] }[],
): Rejection {
  const [issue] = issues;
  const field = issue?.path[0];
  return {
    reason: "invalid_schema",
    issue_count: issues.length,
    ...(typeof field === "string" && SCHEMA_FIELDS.has(field) ? { field } : {}),
    ...(issue && SCHEMA_ISSUE_CODES.has(issue.code)
      ? { issue_code: issue.code }
      : {}),
  };
}

function describeFailure(
  error: unknown,
  stage: Stage,
  // Only for a list request; adds fixed labels to an unexpected failure.
  listAccess?: WorkspaceAccess,
): Rejection {
  if (error instanceof AuthorizationRejection)
    return { reason: error.reason, stage };
  if (error instanceof ChatSDKError) {
    const reason =
      stage === "history_access" && error.type === "forbidden"
        ? "history_access_denied"
        : stage === "cost_gate" && error.type === "forbidden"
          ? "cost_suspended"
          : stage === "project"
            ? "project_unavailable"
            : "request_denied";
    return {
      reason,
      stage,
      error_type: ERROR_TYPES.includes(error.type) ? error.type : "other",
      error_surface: ERROR_SURFACES.includes(error.surface)
        ? error.surface
        : "other",
    };
  }
  if (error instanceof WorkspaceFileError)
    return {
      // Allow-listed by filesystemListDiagnostics; present only for reader list
      // not_found/unreadable_path, never auth or sandbox lookup failures.
      ...error.diagnostics,
      reason: "workspace_file_error",
      stage,
      error_code: WORKSPACE_ERROR_CODES.has(error.code) ? error.code : "other",
    };
  if (error instanceof CloudWorkspaceUnavailableError)
    return {
      reason: "recovery_required",
      stage,
      recovery_reason:
        CloudWorkspaceUnavailableError.getCleanupClaimFailureReason(error),
    };
  return {
    reason: "unexpected_error",
    stage,
    error_name:
      error instanceof Error && ERROR_NAMES.has(error.name)
        ? error.name
        : "other",
    ...(stage === "workspace" && listAccess
      ? {
          reader: listAccess.reader,
          ...(listAccess.step && ACCESS_STEPS.has(listAccess.step)
            ? { failed_step: listAccess.step }
            : {}),
        }
      : {}),
  };
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
    // Read-only capability probe: it may retry one transport failure of the
    // history read. POST keeps the single read before any sandbox access.
    await authorize(req, chatId, undefined, {
      retryNetworkFailure: true,
      signal: req.signal,
    });
    return json({ enabled: true });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  let userId: string | undefined;
  let action: string | undefined;
  const progress: { stage: Stage } = { stage: "request" };
  let access: WorkspaceAccess | undefined;
  const reject = (error: string, status: number, fields: Rejection) => {
    logRejection(status, action, fields);
    return json({ error }, status);
  };
  try {
    // Cookie-authenticated actions are same-origin, including explicit resume.
    const origin = req.headers.get("origin");
    if (origin && origin !== req.nextUrl.origin)
      return reject("forbidden", 403, { reason: "origin_mismatch" });
    const text = await req.text();
    if (text.length > 8192)
      return reject("invalid_request", 400, { reason: "body_too_large" });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return reject("invalid_request", 400, { reason: "malformed_json" });
    }
    const parsed = workspaceRequest.safeParse(body);
    if (!parsed.success) {
      action = knownAction(body);
      return reject(
        "invalid_request",
        400,
        describeSchemaFailure(parsed.error.issues),
      );
    }
    const input = parsed.data;
    action = input.action;
    const auth = await authorize(req, input.chatId, progress);
    userId = auth.userId;
    const preference = input.environment ?? auth.chat.sandbox_type ?? "e2b";
    const local = preference !== "e2b" && preference !== "cloud";
    if (!local && auth.subscription === "free")
      return reject("subscription_required", 403, {
        reason: "subscription_required",
      });
    if (!["status", "list"].includes(input.action) && !input.sandboxId)
      return reject("invalid_request", 400, { reason: "sandbox_id_missing" });
    progress.stage = "cost_gate";
    await assertUserCanMakeCostIncurringRequest(userId);
    progress.stage = "rate_limit";
    const redis = createRedisClient();
    if (redis) {
      const count = await redis.eval<unknown[], number>(
        "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return n",
        [`workspace_files_rate:${userId}`],
        [],
      );
      if (count > 120)
        return reject("rate_limited", 429, { reason: "rate_limited" });
    }
    let normalizedPreference = preference;
    if (local) {
      progress.stage = "environment";
      const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
      if (!serviceKey)
        throw new WorkspaceFileError("workspace_unavailable", 503);
      normalizedPreference = await getConvexClient().query(
        api.localSandbox.resolveEnvironmentPreferenceForBackend,
        { serviceKey, userId, preference },
      );
    }
    progress.stage = "project";
    const project = local
      ? await resolveProjectExecutionContext({
          chat: auth.chat,
          userId,
          mode: "agent",
          sandboxPreference: normalizedPreference,
        })
      : {};
    progress.stage = "workspace";
    access = { reader: local ? "local" : "cloud" };
    const result = local
      ? await accessLocalWorkspaceFiles(
          userId,
          normalizedPreference,
          input,
          project.workingDirectory,
          access,
        )
      : await accessCloudWorkspaceFiles(
          userId,
          getExecutionRegionForVercelRequest(req),
          input,
          access,
        );
    access = undefined;
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
    const response = failure(error);
    logRejection(response.status, action, () =>
      describeFailure(
        error,
        progress.stage,
        action === "list" ? access : undefined,
      ),
    );
    return response;
  }
}
