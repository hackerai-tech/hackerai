import { withServiceQueryRecovery } from "@/lib/db/service-query-recovery.node";
import { captureGoalLifecycle } from "@/lib/goals/analytics";
import { api, api as goalApi } from "@/convex/_generated/api";
import {
  createIsolatedConvexClient,
  getConvexClient,
  isConvexOutcomeUnknownError,
  type ConvexCallScope,
} from "@/lib/db/convex-client";
import { withAgentConvexScope } from "@/lib/api/agent-convex";
import { getGoal, goalServiceKey, reconcileGoal } from "@/lib/goals/server";
import type { GoalReconciliationStep } from "@/lib/goals/reconciliation-diagnostics";
import type { GoalContract } from "@/lib/goals/contracts";
import { validGoalRequest } from "@/lib/goals/contracts";
import { resolveCloudWorkspaceRegion } from "@/lib/ai/tools/utils/cloud-workspace-routing";
import {
  readCloudWorkspaceState,
  assertCloudWorkspaceAvailable,
} from "@/lib/ai/tools/utils/cloud-workspace-guard";
import { LOCAL_CONNECTION_LOST_FINISH_REASON } from "@/lib/chat/local-connection-stop";
import { requiresManualAgentResume } from "@/lib/chat/manual-agent-resume";
import { STOPPED_RUN_ID } from "@/lib/chat/local-auto-continue";
import { cancelLocalAutoContinuesForChat } from "@/lib/api/local-auto-continue-route";
import {
  enforceRegionalSubscriptionFirst,
  subscriptionFirstCountryFromRequest,
} from "@/lib/experiments/regional-subscription-first.server";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { tasks, auth, idempotencyKeys, sessions } from "@trigger.dev/sdk";
import type { agentLongTask } from "@/trigger/agent-long";
import { geolocation } from "@vercel/functions";
import type { UIMessage } from "ai";

import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import {
  getChatById,
  getUserCustomization,
  handleInitialChatAndUserMessage,
  type InitialChatPersistenceStep,
  setActiveTriggerRun,
  replaceActiveTriggerRun,
} from "@/lib/db/actions";
import {
  assertFreeAgentGates,
  buildExtraUsageConfig,
} from "@/lib/api/chat-stream-helpers";
import {
  AGENT_TRIGGER_TASK_ID,
  type AgentApiEndpoint,
} from "@/lib/api/agent-endpoints";
import {
  handleAgentRouteError,
  type AgentStartGuardBoundary,
} from "@/lib/api/agent-route-errors";
import { getRegionalExecutionContextForVercelRequest } from "@/lib/api/trigger-region";
import {
  coerceAgentPermissionMode,
  coerceSelectedModel,
  normalizeSelectedModelOverrideForSubscription,
} from "@/types";
import { ChatSDKError } from "@/lib/errors";
import {
  requireOptionalIdentifier,
  requireRetiredTemporaryFieldAbsent,
} from "@/lib/api/chat-request-validation";
import { readAnalyticsRequestContext } from "@/lib/analytics/request-context";
import { resolveProjectExecutionContext } from "@/lib/chat/project-context";
import { isDesktopPreference } from "@/lib/sandbox/environment";
import type {
  Todo,
  LimitRescueRequest,
  SandboxPreference,
  SelectedModel,
  SubscriptionTier,
  AgentPermissionMode,
} from "@/types";
import { isLimitRescueRequest } from "@/types";
import { resolveAgentRunSpendCapContinuationModel } from "@/lib/chat/agent-run-spend-cap";
import { HybridSandboxManager } from "@/lib/ai/tools/utils/hybrid-sandbox-manager";
import {
  assertLocalSandboxFallbackAllowed,
  getSandboxWithFallbackGuard,
} from "@/lib/ai/tools/utils/sandbox-fallback";
import { AttachmentLocalCopySetupDeadlineError } from "@/lib/ai/tools/utils/attachment-command";
import {
  getUploadBasePath,
  hasLocalDesktopSourcePaths,
  prepareLocalDesktopAttachmentsForTrigger,
  rewriteSandboxFilePathsInMessages,
  stripLocalDesktopSourcePaths,
  uploadSandboxFiles,
} from "@/lib/utils/sandbox-file-utils";
import {
  AGENT_APPROVAL_PROTOCOL_VERSION,
  AGENT_APPROVAL_TOKEN_EXPIRATION,
  cancelAgentTriggerRun,
  closeAgentApprovalSession,
} from "@/lib/api/agent-approval-session";
import { createAgentRunCorrelationToken } from "@/lib/api/agent-run-correlation";
import {
  buildAgentApprovalSessionId,
  buildAgentRunDedupeKeyParts,
  buildAgentRunIdempotencyKey,
  finalizeStartedAgentRun,
  getAgentTriggerMachine,
  getAgentTriggerPriority,
  isAgentRunAssociationUnconfirmed,
  type AgentRunPreviousOwner,
} from "@/lib/api/agent-run-start";

// Existing importers of the route module keep working.
export {
  buildAgentApprovalSessionId,
  buildAgentRunDedupeKeyParts,
  finalizeStartedAgentRun,
  getAgentTriggerMachine,
};
import {
  AGENT_START_REJECTION_HEADER,
  AGENT_START_TRIGGER_PAYLOAD_TOO_LARGE,
} from "@/lib/agent-start-response";
import {
  DEFAULT_AGENT_AUTO_REVIEW_ASSIGNMENT,
  type AgentAutoReviewAssignment,
} from "@/lib/experiments/agent-auto-review";

// Both Agent routes have a 60s maxDuration. Desktop local-copy shell/path
// setup for one admission shares this budget from handler entry, leaving room
// for an in-flight setup command's bounded Stop and the response.
const DESKTOP_LOCAL_COPY_SETUP_BUDGET_MS = 45_000;

// Trigger.dev rejects a single trigger payload above 3 MiB. tasks.trigger()
// offloads large packets, but sessions.start() sends triggerConfig.basePayload
// inline, so enforce the documented payload boundary before either path.
export const AGENT_TRIGGER_PAYLOAD_MAX_BYTES = 3 * 1024 * 1024;

export const getAgentTriggerPayloadSizeBytes = (payload: unknown): number =>
  Buffer.byteLength(JSON.stringify(payload), "utf8");

export const isAgentTriggerPayloadSizeTooLarge = (sizeBytes: number): boolean =>
  sizeBytes > AGENT_TRIGGER_PAYLOAD_MAX_BYTES;

export const isAgentTriggerRequestSizeTooLarge = ({
  payloadBytes,
  requestBodyBytes,
}: {
  payloadBytes: number;
  requestBodyBytes?: number;
}): boolean =>
  isAgentTriggerPayloadSizeTooLarge(requestBodyBytes ?? payloadBytes);

export const isTriggerRequestBodyTooLargeError = (error: unknown): boolean => {
  if (!(error instanceof Error) || error.name !== "TriggerApiError") {
    return false;
  }

  const status = (error as Error & { status?: unknown; statusCode?: unknown })
    .status;
  const statusCode = (
    error as Error & { status?: unknown; statusCode?: unknown }
  ).statusCode;

  return (
    (status === 413 || statusCode === 413) &&
    error.message === "Request body too large"
  );
};

export const createAgentTriggerPayloadTooLargeResponse = () =>
  Response.json(
    {
      code: "bad_request:api",
      message:
        "The request couldn't be processed. Please check your input and try again.",
      cause:
        "This Agent request is too large to start. Remove some attachments or start a new chat and try again.",
    },
    {
      status: 413,
      headers: {
        [AGENT_START_REJECTION_HEADER]: AGENT_START_TRIGGER_PAYLOAD_TOO_LARGE,
      },
    },
  );

type AgentDeploymentEnvironment = {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
  TRIGGER_VERSION?: string;
  TRIGGER_EXTERNAL_DEPLOYMENT_ID?: string;
  TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION?: string;
  VERCEL_GIT_COMMIT_SHA?: string;
};

export const getAgentApprovalDeploymentPin = (
  environment: AgentDeploymentEnvironment = process.env,
): { lockToVersion?: string; externalDeploymentId?: string } => {
  // Preserve the legacy pin until the coordinated migration removes it.
  const workerVersion = environment.TRIGGER_VERSION?.trim();
  if (workerVersion) return { lockToVersion: workerVersion };

  const normalizeId = (value: string | undefined) => {
    const id = value?.trim();
    return id && id.length <= 128 ? id : undefined;
  };
  const automatic =
    environment.TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION?.trim().toLowerCase();
  // Match the SDK's explicit-id / Vercel discovery precedence. Pass the pin
  // explicitly so Session identity and the worker it schedules cannot diverge.
  const externalDeploymentId =
    normalizeId(environment.TRIGGER_EXTERNAL_DEPLOYMENT_ID) ??
    (automatic === "1" || automatic === "true"
      ? normalizeId(environment.VERCEL_GIT_COMMIT_SHA)
      : undefined);
  return externalDeploymentId ? { externalDeploymentId } : {};
};

export const shouldRequireAgentApprovalDeploymentPin = (
  environment: AgentDeploymentEnvironment = process.env,
) =>
  environment.VERCEL_ENV
    ? environment.VERCEL_ENV === "production"
    : environment.NODE_ENV === "production";

type AgentGoalRequest =
  | ({
      action: "start";
      expectedGeneration?: number;
      objective: string;
      criteria: string[];
    } & GoalContract)
  | { action: "resume"; expectedGeneration?: number; resumeOnReply?: boolean };
type AgentTriggerRequestBody = {
  goal?: AgentGoalRequest;
  messages: UIMessage[];
  chatId: string;
  todos?: Todo[];
  regenerate?: boolean;
  sandboxPreference?: SandboxPreference;
  agentPermissionMode?: AgentPermissionMode;
  selectedModel?: string;
  isAutoContinue?: boolean;
  isAutomaticContinuation?: boolean;
  limitRescue?: LimitRescueRequest;
  agentRunRequestId?: string;
  projectId?: string;
  /** Only the server's automatic continuation of a claimed stop sends this. */
  localAutoContinue?: { stoppedRunId: string };
};

export const buildAgentPermissionRunSnapshot = (mode: AgentPermissionMode) => ({
  mode,
  triggerTag: `permission_${mode}`,
  requiresApprovalSession: mode === "ask_approval" || mode === "auto_review",
});

export const AGENT_APPROVAL_TRIGGER_TAG_LIMIT = 5;

/**
 * Session records accept more tags than their persisted trigger config. Keep
 * the ordered run-identifying tags and leave lower-priority cohort tags on the
 * Session record and in metadata.
 */
export const getAgentApprovalTriggerTags = (
  triggerTags: readonly string[],
): string[] => triggerTags.slice(0, AGENT_APPROVAL_TRIGGER_TAG_LIMIT);

type AgentTriggerRequestParseResult =
  | { ok: true; body: AgentTriggerRequestBody }
  | { ok: false; response: NextResponse };

const parseAgentTriggerRequestBody = async (
  req: NextRequest,
): Promise<AgentTriggerRequestParseResult> => {
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return {
      ok: false,
      response: new NextResponse("Invalid JSON body", { status: 400 }),
    };
  }

  if (typeof rawBody !== "object" || rawBody === null) {
    return {
      ok: false,
      response: new NextResponse("Invalid JSON body", { status: 400 }),
    };
  }

  requireRetiredTemporaryFieldAbsent(rawBody);

  const body = rawBody as Record<string, unknown>;
  if (typeof body.chatId !== "string" || body.chatId.length === 0) {
    return {
      ok: false,
      response: new NextResponse("chatId required", { status: 400 }),
    };
  }
  if (!Array.isArray(body.messages)) {
    return {
      ok: false,
      response: new NextResponse("messages must be an array", { status: 400 }),
    };
  }
  if (
    body.messages.some(
      (message) =>
        message === null ||
        typeof message !== "object" ||
        !Array.isArray(message.parts),
    )
  ) {
    return {
      ok: false,
      response: new NextResponse("Each message must include a parts array", {
        status: 400,
      }),
    };
  }
  if (
    body.agentRunRequestId !== undefined &&
    (typeof body.agentRunRequestId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(body.agentRunRequestId))
  ) {
    return {
      ok: false,
      response: new NextResponse("Invalid Agent run request ID", {
        status: 400,
      }),
    };
  }

  const localAutoContinue = body.localAutoContinue as
    { stoppedRunId?: unknown } | undefined;
  if (
    localAutoContinue !== undefined &&
    (typeof localAutoContinue !== "object" ||
      localAutoContinue === null ||
      typeof localAutoContinue.stoppedRunId !== "string" ||
      !STOPPED_RUN_ID.test(localAutoContinue.stoppedRunId) ||
      body.isAutoContinue !== true ||
      body.isAutomaticContinuation === true)
  ) {
    return {
      ok: false,
      response: new NextResponse("Invalid automatic continuation", {
        status: 400,
      }),
    };
  }

  if (body.goal !== undefined && !validGoalRequest(body.goal)) {
    return {
      ok: false,
      response: new NextResponse("Invalid goal request", { status: 400 }),
    };
  }
  return {
    ok: true,
    body: {
      goal: body.goal as AgentGoalRequest | undefined,
      messages: body.messages as UIMessage[],
      chatId: body.chatId,
      todos: Array.isArray(body.todos) ? (body.todos as Todo[]) : undefined,
      regenerate: body.regenerate === true,
      sandboxPreference:
        typeof body.sandboxPreference === "string"
          ? (body.sandboxPreference as SandboxPreference)
          : undefined,
      agentPermissionMode: coerceAgentPermissionMode(
        typeof body.agentPermissionMode === "string"
          ? body.agentPermissionMode
          : undefined,
      ),
      selectedModel:
        typeof body.selectedModel === "string" ? body.selectedModel : undefined,
      isAutoContinue: body.isAutoContinue === true,
      isAutomaticContinuation:
        body.isAutoContinue === true && body.isAutomaticContinuation === true,
      limitRescue: isLimitRescueRequest(body.limitRescue)
        ? body.limitRescue
        : undefined,
      agentRunRequestId:
        typeof body.agentRunRequestId === "string"
          ? body.agentRunRequestId
          : undefined,
      projectId: requireOptionalIdentifier("projectId", body.projectId),
      ...(localAutoContinue && {
        localAutoContinue: {
          stoppedRunId: localAutoContinue.stoppedRunId as string,
        },
      }),
    },
  };
};

/** Share recovery across admission reads without replaying persistence or run dispatch. */
export const createAgentTriggerPost = ({
  endpoint,
}: {
  endpoint: AgentApiEndpoint;
}) =>
  withServiceQueryRecovery(async (req: NextRequest) => {
    const routeStartedAt = Date.now();
    let stage = "parse_request";
    let initialPersistenceStep: InitialChatPersistenceStep | undefined;
    let desktopAttachmentStep:
      | "sandbox_context"
      | "acquire_sandbox"
      | "upload_files"
      | "close_sandbox"
      | undefined;
    // Observational only: names the existing guard callsite still in progress.
    let guardBoundary: AgentStartGuardBoundary | undefined;
    let goalReconciliationStep: GoalReconciliationStep | undefined;
    const diagnosticContext: {
      requestId?: string;
      userId?: string;
      chatId?: string;
      runId?: string;
    } = {
      requestId: req.headers.get("x-vercel-id")?.slice(0, 128) ?? undefined,
    };
    // A platform timeout cannot run catch/finally. Emit the in-flight phase
    // before that deadline, without including request contents or credentials.
    const slowRequestInterval = setInterval(() => {
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          event: "agent_start_slow_request",
          service: "hackerai-web",
          environment:
            process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
          endpoint,
          request_id: diagnosticContext.requestId,
          user_id: diagnosticContext.userId,
          chat_id: diagnosticContext.chatId,
          trigger_run_id: diagnosticContext.runId,
          stage,
          ...(stage === "persist_user_message" && initialPersistenceStep
            ? { initial_persistence_step: initialPersistenceStep }
            : {}),
          ...(stage === "prepare_desktop_attachments" && desktopAttachmentStep
            ? { desktop_attachment_step: desktopAttachmentStep }
            : {}),
          elapsed_ms: Date.now() - routeStartedAt,
        }),
      );
    }, 10_000);
    let reservedGoal:
      { chatId: string; userId: string; generation: number } | undefined;
    // Goal lifecycle reads and writes keep their existing unbounded timing and
    // order, on one fresh client per admission so another chat's pending write
    // on the shared singleton cannot hold them.
    let goalConvex: ConvexCallScope | undefined;
    const getGoalConvex = () =>
      (goalConvex ??= { client: createIsolatedConvexClient() });
    const releaseReservedGoal = async () => {
      if (!reservedGoal) return;
      const goal = reservedGoal;
      reservedGoal = undefined;
      try {
        await getGoalConvex().client.mutation(goalApi.agentGoals.failDispatch, {
          serviceKey: goalServiceKey(),
          ...goal,
        });
      } catch {
        // A persistence outage leaves the goal fenced for explicit recovery.
      }
      await captureGoalLifecycle("admission_failed", {
        ...goal,
        goalGeneration: goal.generation,
      });
    };
    try {
      const parsedBody = await parseAgentTriggerRequestBody(req);
      if (!parsedBody.ok) return parsedBody.response;
      const analyticsRequestContext = readAnalyticsRequestContext(req.headers);

      const {
        messages,
        chatId,
        todos,
        regenerate,
        sandboxPreference,
        agentPermissionMode = "full_access",
        selectedModel: rawSelectedModel,
        isAutoContinue,
        isAutomaticContinuation,
        limitRescue,
        agentRunRequestId,
        projectId: requestedProjectId,
        goal: goalRequest,
        localAutoContinue,
      } = parsedBody.body;

      diagnosticContext.chatId = chatId.slice(0, 128);
      stage = "authenticate";
      const {
        userId,
        subscription,
        organizationId,
        freeQuotaSubject: legacyQuotaSubject,
        freeUsageQuotaSubject,
      } = await getUserIDAndPro(req);
      const freeQuotaSubject = freeUsageQuotaSubject ?? legacyQuotaSubject;
      diagnosticContext.userId = userId.slice(0, 128);
      if (localAutoContinue) {
        // Only the one claimed start of this stop may run as automatic.
        stage = "local_auto_continue_claim";
        const claim = await getConvexClient().query(
          api.agentLocalAutoContinues.getClaim,
          {
            serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
            stoppedRunId: localAutoContinue.stoppedRunId,
          },
        );
        if (!claim || claim.userId !== userId || claim.chatId !== chatId)
          return new NextResponse(
            "This automatic continuation is no longer pending.",
            { status: 409 },
          );
      }
      let selectedModelOverride: SelectedModel | undefined =
        normalizeSelectedModelOverrideForSubscription(
          coerceSelectedModel(rawSelectedModel ?? null),
          subscription,
        );
      stage = "access_gates";
      guardBoundary = "account_access_gate";
      await assertUserCanMakeCostIncurringRequest(userId, {
        retryNetworkFailure: true,
        signal: req.signal,
      });
      guardBoundary = undefined;
      const regionalSubscriptionCountry =
        subscriptionFirstCountryFromRequest(req);
      guardBoundary = "regional_subscription_gate";
      await enforceRegionalSubscriptionFirst({
        userId,
        subscription,
        country: regionalSubscriptionCountry,
        surface: "agent",
      });
      guardBoundary = undefined;
      const userLocation = geolocation(req);
      const { triggerRegion: requestTriggerRegion, requestRegionClass } =
        getRegionalExecutionContextForVercelRequest(req, userLocation);
      const genericDelegationEnabled = true;

      guardBoundary = "free_agent_sandbox_gate";
      assertFreeAgentGates({
        mode: "agent",
        subscription,
        sandboxPreference,
      });
      guardBoundary = undefined;

      stage = "workspace_routing";
      const triggerRegion =
        !sandboxPreference || sandboxPreference === "e2b"
          ? await resolveCloudWorkspaceRegion({
              userId,
              preferredRegion: requestTriggerRegion,
              signal: req.signal,
            })
          : requestTriggerRegion;

      // Serialize cloud Agent admission with recovery before a run is queued.
      // The same activity/fence CAS protects acquisition and cached clients.
      if (!sandboxPreference || sandboxPreference === "e2b") {
        const workspace = await readCloudWorkspaceState(userId);
        await assertCloudWorkspaceAvailable(
          userId,
          workspace?.phase === "e2b" ? workspace.destinationId : undefined,
          triggerRegion,
        );
      }

      const requestMessages = Array.isArray(messages) ? messages : [];
      if (!regenerate && !isAutoContinue && requestMessages.length === 0) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "agent_empty_message_payload_rejected",
            service: "chat-handler",
            endpoint,
            timestamp: new Date().toISOString(),
            chat_id: chatId,
            user_id: userId,
            subscription,
          }),
        );
        throw new ChatSDKError(
          "bad_request:api",
          "No message content was found for this request. Please send a new message and try again.",
          {
            empty_prompt: true,
            new_messages_count: 0,
          },
        );
      }

      // These independent authorization/config reads used to run serially
      // before Trigger was called. Overlap them so the worker starts booting as
      // soon as possible after the suspension check succeeds.
      stage = "load_chat_and_preferences";
      const [existingChat, userCustomization] = await Promise.all([
        withAgentConvexScope("startChatRead", (convex) =>
          getChatById({ id: chatId }, convex),
        ),
        getUserCustomization({ userId }),
      ]);
      if (
        existingChat?.user_id === userId &&
        existingChat.active_agent_user_wait
      ) {
        return new NextResponse(
          "Agent is waiting for your reply in this chat. Reply to continue or stop the run first.",
          { status: 409 },
        );
      }

      if (
        goalRequest &&
        (subscription === "free" ||
          limitRescue ||
          (regenerate &&
            (goalRequest.action !== "resume" ||
              goalRequest.expectedGeneration === undefined)))
      ) {
        guardBoundary = "persistent_goal_request_gate";
        throw new ChatSDKError(
          "forbidden:chat",
          "Persistent goals are unavailable for this request.",
        );
      }
      if (existingChat && existingChat.user_id !== userId) {
        guardBoundary = "chat_owner_gate";
        throw new ChatSDKError("forbidden:chat");
      }
      stage = "reconcile_goal";
      const existingGoal = existingChat
        ? await reconcileGoal(
            chatId,
            userId,
            (step) => {
              goalReconciliationStep = step;
            },
            getGoalConvex(),
          )
        : null;
      // Later local guards did not fail inside a reconciliation step.
      goalReconciliationStep = undefined;
      if (
        !goalRequest &&
        existingGoal &&
        (existingGoal.activeRunId ||
          ["queued", "running", "waiting", "needs_approval"].includes(
            existingGoal.state,
          ))
      )
        throw new ChatSDKError(
          "bad_request:api",
          "Pause the goal and wait for its current run to settle before sending another Agent request.",
        );
      if (
        goalRequest?.action === "resume" &&
        existingGoal &&
        (existingGoal.sandboxPreference !== (sandboxPreference ?? "e2b") ||
          existingGoal.permissionMode !== agentPermissionMode ||
          existingGoal.selectedModel !== (selectedModelOverride ?? "auto"))
      )
        throw new ChatSDKError(
          "bad_request:api",
          "Restore the goal’s original sandbox, model and permission mode before resuming.",
        );
      // Fetch existing chat to: (a) detect isNewChat for title generation,
      // (b) pass to handleInitialChatAndUserMessage so it skips saveChat on
      //     regenerate/auto-continue and does the ownership check instead.
      stage = "resolve_execution_context";
      const [projectContext, extraUsageConfig] = await Promise.all([
        resolveProjectExecutionContext({
          chat: existingChat,
          requestedProjectId,
          userId,
          mode: "agent",
          sandboxPreference,
        }),
        buildExtraUsageConfig({
          userId,
          subscription,
          userCustomization,
          organizationId,
        }),
      ]);
      // A stale client may still send its automatic continuation after the
      // run saved a stop that only the user can resume.
      if (
        isAutomaticContinuation &&
        requiresManualAgentResume(existingChat?.finish_reason)
      ) {
        throw new ChatSDKError(
          "bad_request:api",
          existingChat?.finish_reason === LOCAL_CONNECTION_LOST_FINISH_REASON
            ? "The local connection was lost. Resume manually from the chat when your computer is connected."
            : "Browser takeover was not completed in time. Resume manually from the chat when you're ready.",
        );
      }
      const isNewChat = !existingChat && !regenerate && !isAutoContinue;
      const autoReviewAssignment: AgentAutoReviewAssignment | undefined =
        agentPermissionMode === "auto_review"
          ? DEFAULT_AGENT_AUTO_REVIEW_ASSIGNMENT
          : undefined;
      selectedModelOverride = resolveAgentRunSpendCapContinuationModel({
        finishReason: existingChat?.finish_reason,
        isAutoContinue,
        mode: "agent",
        subscription,
        selectedModelOverride,
        extraUsageConfig,
      });
      let messagesForPersistence =
        stripLocalDesktopSourcePaths(requestMessages);
      let messagesForTrigger = messagesForPersistence;
      let localDesktopAttachmentsPrepared = false;

      if (hasLocalDesktopSourcePaths(requestMessages)) {
        stage = "prepare_desktop_attachments";
        if (!isDesktopPreference(sandboxPreference ?? "e2b")) {
          throw new ChatSDKError(
            "bad_request:api",
            "Desktop-local attachments can only be used with the desktop sandbox.",
          );
        }

        let { messages: preparedMessages, sandboxFiles } =
          prepareLocalDesktopAttachmentsForTrigger(
            requestMessages,
            getUploadBasePath("desktop"),
          );
        if (sandboxFiles.length > 0) {
          const sandboxManager = new HybridSandboxManager(
            userId,
            () => {},
            sandboxPreference,
            process.env.CONVEX_SERVICE_ROLE_KEY!,
            null,
            subscription,
          );
          desktopAttachmentStep = "sandbox_context";
          await sandboxManager.getSandboxContextForPrompt();
          assertLocalSandboxFallbackAllowed({
            fallbackInfo: sandboxManager.consumeFallbackInfo(),
            requireLocalSandbox: true,
          });

          let stagedSandbox: any = null;
          let uploadResult: Awaited<ReturnType<typeof uploadSandboxFiles>>;
          try {
            desktopAttachmentStep = "upload_files";
            uploadResult = await uploadSandboxFiles(
              sandboxFiles,
              async () => {
                desktopAttachmentStep = "acquire_sandbox";
                const { sandbox } = await getSandboxWithFallbackGuard({
                  sandboxManager,
                  requireLocalSandbox: true,
                });
                stagedSandbox = sandbox;
                desktopAttachmentStep = "upload_files";
                return sandbox;
              },
              {
                localCopySetupDeadlineAt:
                  routeStartedAt + DESKTOP_LOCAL_COPY_SETUP_BUDGET_MS,
                logContext: {
                  service: "hackerai-web",
                  requestId:
                    req.headers.get("x-vercel-id")?.slice(0, 128) ?? undefined,
                  userId,
                  chatId: chatId.slice(0, 128),
                },
              },
            );
          } catch (error) {
            // Unconfirmed cancellation and other failures keep their own path.
            if (!(error instanceof AttachmentLocalCopySetupDeadlineError))
              throw error;
            throw new ChatSDKError(
              "bad_request:api",
              "Your computer took too long to prepare local attachments. Reconnect this computer, then send the message again.",
            );
          } finally {
            desktopAttachmentStep = "close_sandbox";
            await stagedSandbox?.close?.().catch(() => {});
          }
          if (uploadResult.failedCount > 0) {
            const noun =
              uploadResult.failedCount === 1 ? "attachment" : "attachments";
            throw new ChatSDKError(
              "bad_request:api",
              `Failed to prepare ${uploadResult.failedCount} local ${noun}. Reconnect this computer and retry the message. If the file was moved or deleted, reattach it.`,
            );
          }
          preparedMessages = rewriteSandboxFilePathsInMessages(
            preparedMessages,
            uploadResult.pathRewrites,
          );
        }
        messagesForTrigger = preparedMessages;
        localDesktopAttachmentsPrepared = true;
      }

      const reserveGoal = async () => {
        if (!goalRequest) return;
        const goalClient = getGoalConvex().client;
        const savedGoal =
          goalRequest.action === "start"
            ? await goalClient.mutation(goalApi.agentGoals.start, {
                serviceKey: goalServiceKey(),
                chatId,
                userId,
                ...(goalRequest.expectedGeneration !== undefined
                  ? { expectedGeneration: goalRequest.expectedGeneration }
                  : {}),
                objective: goalRequest.objective,
                criteria: goalRequest.criteria,
                verificationCommand: goalRequest.verificationCommand,
                constraints: goalRequest.constraints,
                boundaries: goalRequest.boundaries,
                stopWhen: goalRequest.stopWhen,
                sandboxPreference: sandboxPreference ?? "e2b",
                permissionMode: agentPermissionMode,
                selectedModel: selectedModelOverride ?? "auto",
              })
            : await goalClient.mutation(goalApi.agentGoals.control, {
                serviceKey: goalServiceKey(),
                chatId,
                userId,
                action: "resume",
                ...(goalRequest.resumeOnReply ? { resumeOnReply: true } : {}),
                ...(goalRequest.expectedGeneration !== undefined
                  ? { generation: goalRequest.expectedGeneration }
                  : {}),
              });
        reservedGoal = { chatId, userId, generation: savedGoal.generation };
        await captureGoalLifecycle(
          goalRequest.action === "start" ? "admitted" : "resumed",
          { chatId, userId, subscription },
          savedGoal,
        );
      };

      // Fence an existing goal before writing input that a queued worker could
      // otherwise consume. New chats must exist before reserving their goal.
      if (existingChat) await reserveGoal();
      stage = "persist_user_message";
      // One isolated, bounded client runs this admission's chat and message
      // writes in order. Started after Desktop attachment uploads so they
      // cannot spend it, and outside the singleton's queue so another chat's
      // pending write cannot hold them. Goal writes and analytics stay outside.
      await withAgentConvexScope("startPersistence", (persistence) =>
        handleInitialChatAndUserMessage(
          {
            chatId,
            userId,
            messages: messagesForPersistence,
            regenerate,
            chat: existingChat ?? null,
            isHidden: isAutoContinue ? true : undefined,
            projectId: projectContext.projectId,
            sandboxType: sandboxPreference ?? "e2b",
            onPersistenceStep: (step) => {
              initialPersistenceStep = step;
            },
          },
          persistence,
        ),
      );
      initialPersistenceStep = undefined;

      if (!existingChat) await reserveGoal();
      if (reservedGoal && goalRequest?.action === "start") {
        const goalMessage = messagesForPersistence.findLast(
          (m) => m.role === "user",
        );
        if (goalMessage)
          await getGoalConvex().client.mutation(
            goalApi.agentGoals.markMessage,
            {
              serviceKey: goalServiceKey(),
              ...reservedGoal,
              messageId: goalMessage.id,
            },
          );
      }
      // Snapshot permission behavior once for this run. UI changes made while
      // it is active apply to the next run and cannot mutate a resumed run.
      const permissionSnapshot =
        buildAgentPermissionRunSnapshot(agentPermissionMode);
      const triggerTags = [`user_${userId}`, `chat_${chatId}`];
      if (subscription !== "free") triggerTags.push(`sub_${subscription}`);
      triggerTags.push(permissionSnapshot.triggerTag);

      // Persisted chats are rehydrated from Convex inside the task after the
      // route saves the latest user message. Avoid sending the same history
      // through Trigger unless the task cannot rehydrate it, or the route has
      // prepared desktop-local attachment tags that only exist in this payload.
      const messagesForPayload = localDesktopAttachmentsPrepared
        ? messagesForTrigger
        : [];

      const triggerRequestedAt = Date.now();
      const triggerPriority = getAgentTriggerPriority(subscription);
      const triggerMachine = getAgentTriggerMachine(subscription);
      const approvalDeploymentPin = getAgentApprovalDeploymentPin();
      const approvalWorkerVersion = approvalDeploymentPin.lockToVersion;
      const approvalExternalDeploymentId =
        approvalDeploymentPin.externalDeploymentId;
      const triggerDedupeKeyParts = buildAgentRunDedupeKeyParts({
        userId,
        chatId,
        requestMessages,
        regenerate,
        isAutoContinue,
        existingChatUpdateTime: existingChat?.update_time,
        triggerRequestedAt,
        agentRunRequestId,
      });
      stage = "create_idempotency_key";
      const triggerIdempotencyKey = await buildAgentRunIdempotencyKey(
        triggerDedupeKeyParts,
      );
      const approvalSessionId = permissionSnapshot.requiresApprovalSession
        ? buildAgentApprovalSessionId({
            chatId,
            keyParts: triggerDedupeKeyParts,
            approvalProtocolVersion: AGENT_APPROVAL_PROTOCOL_VERSION,
            approvalWorkerVersion,
            approvalExternalDeploymentId,
          })
        : undefined;
      if (
        approvalSessionId &&
        shouldRequireAgentApprovalDeploymentPin() &&
        !approvalWorkerVersion &&
        !approvalExternalDeploymentId
      ) {
        throw new ChatSDKError(
          "bad_request:api",
          "Agent approval is temporarily unavailable while its worker version is being deployed.",
        );
      }
      // Approval protocol rollout order is Convex -> Trigger worker -> Vercel.
      // The v2 worker must reject unsupported approvalProtocolVersion values;
      // old workers ignore this field, so the route that emits v2 deploys last.
      const agentPayload = {
        ...(reservedGoal ? { goalGeneration: reservedGoal.generation } : {}),
        chatId,
        userId,
        subscription,
        organizationId,
        freeQuotaSubject,
        regionalSubscriptionCountry,
        messages: messagesForPayload,
        localDesktopAttachmentsPrepared,
        // Trigger's sessions.start() caps the entire inline body at 32 KiB.
        // The Agent worker loads todos from Convex, so the session doesn't need
        // the client's duplicate list. Keep the field's array shape.
        baseTodos: approvalSessionId || !Array.isArray(todos) ? [] : todos,
        sandboxPreference,
        agentPermissionMode: permissionSnapshot.mode,
        approvalSessionId,
        approvalProtocolVersion: AGENT_APPROVAL_PROTOCOL_VERSION,
        selectedModel: selectedModelOverride,
        autoReviewAssignment,
        userLocation,
        triggerRegion,
        requestRegionClass,
        isAutoContinue,
        isAutomaticContinuation,
        // Content-free analytics link: the run resumes a saved manual stop,
        // by the user or by the server once its computer came back.
        ...(isAutoContinue &&
          !isAutomaticContinuation &&
          requiresManualAgentResume(existingChat?.finish_reason) && {
            resumeFromFinishReason: existingChat.finish_reason,
            resumeTrigger: localAutoContinue
              ? ("automatic" as const)
              : ("manual" as const),
          }),
        ...(localAutoContinue && {
          localAutoContinueOfRunId: localAutoContinue.stoppedRunId,
        }),
        regenerate,
        limitRescue,
        isNewChat,
        endpoint,
        analyticsRequestContext,
        genericDelegationEnabled,
        convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
        requestTiming: {
          routeStartedAt,
          triggerRequestedAt,
        },
      };
      const triggerPayloadBytes = getAgentTriggerPayloadSizeBytes(agentPayload);
      const triggerApiMethod = approvalSessionId
        ? "sessions.start"
        : "tasks.trigger";
      const requestId = req.headers.get("x-vercel-id");
      const webRequestId =
        requestId &&
        requestId.length <= 128 &&
        /^(?:[a-z0-9-]{1,32}::)?[a-z0-9]{3,12}-\d{13}-[a-f0-9]{12,64}$/.test(
          requestId,
        )
          ? requestId
          : undefined;
      const triggerMetadata = {
        status: "queued",
        chatId,
        userId,
        subscription,
        loginRequired: false,
        endpoint,
        // Task metadata identifies its creating request. Session metadata may
        // reflect a later cached start; it does not prove that start made a run.
        ...(webRequestId ? { webRequestId } : {}),
        routeStartedAt,
        triggerRequestedAt,
        triggerPriority,
        triggerMachine,
        requestMessageCount: requestMessages.length,
        triggerPayloadMessageCount: messagesForPayload.length,
        agentPermissionMode: permissionSnapshot.mode,
        genericDelegationEnabled,
        approvalProtocolVersion: AGENT_APPROVAL_PROTOCOL_VERSION,
        ...(approvalWorkerVersion ? { approvalWorkerVersion } : {}),
        ...(approvalExternalDeploymentId
          ? { approvalExternalDeploymentId }
          : {}),
        ...(approvalSessionId ? { approvalSessionId } : {}),
        ...(autoReviewAssignment && {
          autoReviewRolloutPhase: autoReviewAssignment.phase,
        }),
      };
      const triggerOptions = {
        ...(triggerPriority > 0 ? { priority: triggerPriority } : {}),
        machine: triggerMachine,
        tags: triggerTags,
        region: triggerRegion,
        idempotencyKey: triggerIdempotencyKey,
        idempotencyKeyTTL: "6h",
        metadata: triggerMetadata,
      };
      let triggerRequestBodyBytes: number | undefined;
      const triggerPayloadTooLargeResponse = async (
        reason: "payload_limit_exceeded" | "trigger_api_413",
      ) => {
        console.warn(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "warn",
            event: "agent_trigger_payload_rejected",
            service: "hackerai-web",
            environment:
              process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
            endpoint,
            reason,
            http_status: 413,
            trigger_api_method: triggerApiMethod,
            trigger_payload_bytes: triggerPayloadBytes,
            trigger_request_body_bytes: triggerRequestBodyBytes,
            trigger_payload_limit_bytes: AGENT_TRIGGER_PAYLOAD_MAX_BYTES,
            trigger_payload_message_count: messagesForPayload.length,
            base_todos_count: Array.isArray(todos) ? todos.length : 0,
            local_desktop_attachments_prepared: localDesktopAttachmentsPrepared,
            agent_permission_mode: permissionSnapshot.mode,
            request_id:
              req.headers.get("x-vercel-id")?.slice(0, 128) ?? "unknown",
            user_id: userId.slice(0, 128),
            chat_id: chatId.slice(0, 128),
            organization_id: organizationId?.slice(0, 128),
          }),
        );

        await releaseReservedGoal();
        return createAgentTriggerPayloadTooLargeResponse();
      };

      const approvalTriggerConfig = {
        basePayload: agentPayload,
        machine: triggerMachine,
        tags: getAgentApprovalTriggerTags(triggerTags),
        region: triggerRegion,
        ...approvalDeploymentPin,
      };
      const approvalSessionBody = approvalSessionId
        ? {
            type: `agent-long-approval.v${AGENT_APPROVAL_PROTOCOL_VERSION}`,
            externalId: approvalSessionId,
            taskIdentifier: AGENT_TRIGGER_TASK_ID,
            tags: triggerTags,
            metadata: triggerMetadata,
            triggerConfig: approvalTriggerConfig,
          }
        : undefined;
      if (approvalSessionBody)
        triggerRequestBodyBytes =
          getAgentTriggerPayloadSizeBytes(approvalSessionBody);
      if (
        isAgentTriggerRequestSizeTooLarge({
          payloadBytes: triggerPayloadBytes,
          requestBodyBytes: triggerRequestBodyBytes,
        })
      ) {
        return triggerPayloadTooLargeResponse("payload_limit_exceeded");
      }

      // The last ordinary owner read runs before dispatch, so its failure or
      // timeout cannot leave a started run behind. Goal starts are fenced by
      // their generation at association instead.
      let previousOwner: AgentRunPreviousOwner | undefined;
      if (!reservedGoal) {
        stage = "read_previous_owner";
        const ownerChat = await withAgentConvexScope(
          "startPreviousOwnerRead",
          (convex) => getChatById({ id: chatId }, convex),
        );
        if (!ownerChat || ownerChat.deletion_started_at !== undefined)
          throw new ChatSDKError(
            "not_found:chat",
            "The chat was deleted before the Agent run could start.",
          );
        if (ownerChat.user_id !== userId) {
          guardBoundary = "chat_owner_gate";
          throw new ChatSDKError("forbidden:chat");
        }
        previousOwner = {
          runId: ownerChat.active_trigger_run_id ?? null,
          approvalSessionId: ownerChat.active_agent_approval_session_id ?? null,
        };
      }

      let runId: string;
      try {
        stage = triggerApiMethod;
        if (approvalSessionBody) {
          const session = await sessions.start(approvalSessionBody);
          runId = session.runId;
        } else {
          const handle = await tasks.trigger<typeof agentLongTask>(
            AGENT_TRIGGER_TASK_ID,
            agentPayload,
            triggerOptions,
          );
          runId = handle.id;
        }
      } catch (error) {
        if (isTriggerRequestBodyTooLargeError(error)) {
          return triggerPayloadTooLargeResponse("trigger_api_413");
        }
        throw error;
      }

      const triggerCompletedAt = Date.now();
      diagnosticContext.runId = runId;
      stage = "create_tokens_and_associate_run";

      // Claim ownership only after tokens are available, then settle the exact
      // displaced owner. Concurrent admissions cannot overwrite a newer claim.
      const { publicAccessToken, approvalSessionPublicAccessToken } =
        await finalizeStartedAgentRun({
          expectedRunId: existingChat?.active_trigger_run_id ?? null,
          chatId,
          userId,
          runId,
          approvalSessionId,
          goal: reservedGoal,
          previousOwner,
        });
      // The associated worker owns this generation, even if response creation fails.
      reservedGoal = undefined;
      // The user acted first: their message or Resume replaces any automatic
      // continuation still waiting for this chat's computer.
      if (
        !localAutoContinue &&
        existingChat?.finish_reason === LOCAL_CONNECTION_LOST_FINISH_REASON
      )
        await cancelLocalAutoContinuesForChat({
          userId,
          chatId,
          reason: isAutoContinue ? "manual_resume" : "user_message",
        });

      console.info(`[${endpoint}] started trigger run`, {
        chatId,
        runId,
        routeDurationMs: Date.now() - routeStartedAt,
        triggerDurationMs: triggerCompletedAt - triggerRequestedAt,
        triggerPayloadMessageCount: messagesForPayload.length,
        persistedMessageCount: messagesForPersistence.length,
        localDesktopAttachmentsPrepared,
        agentPermissionMode,
      });

      const response = NextResponse.json({
        runId,
        runCorrelationToken: createAgentRunCorrelationToken({
          userId,
          chatId,
          runId,
        }),
        publicAccessToken,
        chatId,
        approvalProtocolVersion: AGENT_APPROVAL_PROTOCOL_VERSION,
        ...(approvalSessionId && approvalSessionPublicAccessToken
          ? {
              approvalSessionId,
              approvalSessionPublicAccessToken,
            }
          : {}),
      });
      return response;
    } catch (error) {
      // The dispatched worker may already own this generation; failing its
      // dispatch would fence out the run the chat can still reconnect to.
      if (isAgentRunAssociationUnconfirmed(error)) reservedGoal = undefined;
      await releaseReservedGoal();
      return handleAgentRouteError({
        error,
        endpoint,
        action: "start",
        fallbackMessage: "Failed to start agent run",
        context: {
          ...diagnosticContext,
          stage,
          initialPersistenceStep,
          guardBoundary,
          goalReconciliationStep,
        },
      });
    } finally {
      clearInterval(slowRequestInterval);
    }
  });
