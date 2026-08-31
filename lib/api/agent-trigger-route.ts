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
  setActiveTriggerRun,
} from "@/lib/db/actions";
import {
  assertFreeAgentGates,
  buildExtraUsageConfig,
} from "@/lib/api/chat-stream-helpers";
import {
  AGENT_TRIGGER_TASK_ID,
  type AgentApiEndpoint,
} from "@/lib/api/agent-endpoints";
import { handleAgentRouteError } from "@/lib/api/agent-route-errors";
import { getTriggerRegionForVercelRequest } from "@/lib/api/trigger-region";
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
  DEFAULT_AGENT_AUTO_REVIEW_ASSIGNMENT,
  type AgentAutoReviewAssignment,
} from "@/lib/experiments/agent-auto-review";
import { getPostHogFeatureFlagForUser } from "@/lib/posthog/server";

type AgentTriggerMachinePreset = "small-1x" | "small-2x";

const AGENT_TRIGGER_MACHINE_BY_SUBSCRIPTION: Record<
  SubscriptionTier,
  AgentTriggerMachinePreset
> = {
  free: "small-1x",
  pro: "small-2x",
  "pro-plus": "small-2x",
  ultra: "small-2x",
  team: "small-2x",
};

const AGENT_TRIGGER_PRIORITY_BY_SUBSCRIPTION: Record<SubscriptionTier, number> =
  {
    free: 0,
    pro: 5,
    "pro-plus": 5,
    ultra: 10,
    team: 5,
  };

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
    { status: 413 },
  );

const getAgentTriggerPriority = (subscription: SubscriptionTier) =>
  AGENT_TRIGGER_PRIORITY_BY_SUBSCRIPTION[subscription];

/** Keep paid Agent starts on the latency-optimized 1 GB worker. */
export const getAgentTriggerMachine = (subscription: SubscriptionTier) =>
  AGENT_TRIGGER_MACHINE_BY_SUBSCRIPTION[subscription];

type AgentDeploymentEnvironment = {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
};

export const shouldRequireAgentApprovalWorkerVersion = (
  environment: AgentDeploymentEnvironment = process.env,
) =>
  environment.VERCEL_ENV
    ? environment.VERCEL_ENV === "production"
    : environment.NODE_ENV === "production";

type AgentTriggerRequestBody = {
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

  return {
    ok: true,
    body: {
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
    },
  };
};

const getLastRequestMessageId = (messages: UIMessage[]): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const id = messages[index]?.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
};

export const buildAgentRunDedupeKeyParts = ({
  userId,
  chatId,
  requestMessages,
  regenerate,
  isAutoContinue,
  existingChatUpdateTime,
  triggerRequestedAt,
  agentRunRequestId,
}: {
  userId: string;
  chatId: string;
  requestMessages: UIMessage[];
  regenerate?: boolean;
  isAutoContinue?: boolean;
  existingChatUpdateTime?: number;
  triggerRequestedAt: number;
  agentRunRequestId?: string;
}) => {
  const operation = regenerate
    ? "regenerate"
    : isAutoContinue
      ? "auto-continue"
      : "send";
  const turnKey =
    (regenerate ? agentRunRequestId : undefined) ??
    getLastRequestMessageId(requestMessages) ??
    (existingChatUpdateTime !== undefined
      ? `chat-update:${existingChatUpdateTime}`
      : `request:${triggerRequestedAt}`);

  return ["agent-run", userId, chatId, operation, turnKey];
};

const buildAgentRunIdempotencyKey = async (
  keyParts: ReturnType<typeof buildAgentRunDedupeKeyParts>,
) => idempotencyKeys.create(keyParts, { scope: "global" });

export const buildAgentApprovalSessionId = ({
  chatId,
  keyParts,
  approvalProtocolVersion,
  approvalWorkerVersion,
}: {
  chatId: string;
  keyParts: ReturnType<typeof buildAgentRunDedupeKeyParts>;
  approvalProtocolVersion: number;
  approvalWorkerVersion: string | undefined;
}) => {
  const digest = createHash("sha256")
    .update(
      [
        `protocol:${approvalProtocolVersion}`,
        `worker:${approvalWorkerVersion ?? "unversioned"}`,
        ...keyParts,
      ].join("\0"),
    )
    .digest("base64url")
    .slice(0, 32);
  return `agent-approval:v${approvalProtocolVersion}:${chatId}:${digest}`;
};

type StartedAgentRunAccess = {
  publicAccessToken: string;
  approvalSessionPublicAccessToken?: string;
};

export const finalizeStartedAgentRun = async ({
  chatId,
  runId,
  approvalSessionId,
}: {
  chatId: string;
  runId: string;
  approvalSessionId: string | undefined;
}): Promise<StartedAgentRunAccess> => {
  try {
    const [publicAccessToken, approvalSessionPublicAccessToken, association] =
      await Promise.all([
        auth.createPublicToken({
          scopes: { read: { runs: [runId] } },
          // 6h is enough to cover the max task duration plus reconnect grace.
          expirationTime: "6h",
        }),
        approvalSessionId
          ? auth.createPublicToken({
              scopes: {
                write: { sessions: approvalSessionId },
              } as any,
              expirationTime: AGENT_APPROVAL_TOKEN_EXPIRATION,
            })
          : Promise.resolve(undefined),
        setActiveTriggerRun({
          chatId,
          triggerRunId: runId,
          approvalSessionId: approvalSessionId ?? null,
        }),
      ]);

    if (association !== "updated") {
      throw new ChatSDKError(
        "not_found:chat",
        "The chat was deleted while the Agent run was starting.",
        { agent_run_association: association },
      );
    }

    return {
      publicAccessToken,
      ...(approvalSessionPublicAccessToken
        ? { approvalSessionPublicAccessToken }
        : {}),
    };
  } catch (error) {
    // A started run must never be returned when its chat association fails.
    // Close both resources because Session close and run cancellation are
    // independently idempotent and either one may already be terminal.
    const cleanupResults = await Promise.allSettled([
      closeAgentApprovalSession(
        approvalSessionId,
        "agent-run-association-failed",
      ),
      cancelAgentTriggerRun(runId),
      setActiveTriggerRun({
        chatId,
        triggerRunId: null,
        approvalSessionId: null,
        expectedRunId: runId,
        clearApprovalPending: true,
      }),
    ]);
    for (const cleanupResult of cleanupResults) {
      if (cleanupResult.status === "rejected") {
        console.error("Failed to clean up an unreturned Agent run:", {
          chatId,
          runId,
          error: cleanupResult.reason,
        });
      }
    }
    throw error;
  }
};

export const createAgentTriggerPost =
  ({ endpoint }: { endpoint: AgentApiEndpoint }) =>
  async (req: NextRequest) => {
    const routeStartedAt = Date.now();
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
      } = parsedBody.body;

      const { userId, subscription, organizationId, freeQuotaSubject } =
        await getUserIDAndPro(req);
      let selectedModelOverride: SelectedModel | undefined =
        normalizeSelectedModelOverrideForSubscription(
          coerceSelectedModel(rawSelectedModel ?? null),
          subscription,
        );
      await assertUserCanMakeCostIncurringRequest(userId);
      const userLocation = geolocation(req);
      const triggerRegion =
        getTriggerRegionForVercelRequest(req, userLocation) ?? "us-east-1";
      const genericDelegationFlagPromise =
        agentPermissionMode === "full_access"
          ? getPostHogFeatureFlagForUser("agent-generic-delegation-v1", userId)
          : Promise.resolve(false);

      assertFreeAgentGates({
        mode: "agent",
        subscription,
        sandboxPreference,
      });

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
      const [existingChat, userCustomization, genericDelegationEnabled] =
        await Promise.all([
          getChatById({ id: chatId }),
          getUserCustomization({ userId }),
          genericDelegationFlagPromise,
        ]);

      // Fetch existing chat to: (a) detect isNewChat for title generation,
      // (b) pass to handleInitialChatAndUserMessage so it skips saveChat on
      //     regenerate/auto-continue and does the ownership check instead.
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
        if (sandboxPreference !== "desktop") {
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
            "desktop",
            process.env.CONVEX_SERVICE_ROLE_KEY!,
            null,
            subscription,
          );
          await sandboxManager.getSandboxContextForPrompt();
          assertLocalSandboxFallbackAllowed({
            fallbackInfo: sandboxManager.consumeFallbackInfo(),
            requireLocalSandbox: true,
          });

          let stagedSandbox: any = null;
          let uploadResult: Awaited<ReturnType<typeof uploadSandboxFiles>>;
          try {
            uploadResult = await uploadSandboxFiles(sandboxFiles, async () => {
              const { sandbox } = await getSandboxWithFallbackGuard({
                sandboxManager,
                requireLocalSandbox: true,
              });
              stagedSandbox = sandbox;
              return sandbox;
            });
          } finally {
            await stagedSandbox?.close?.().catch(() => {});
          }
          if (uploadResult.failedCount > 0) {
            const noun =
              uploadResult.failedCount === 1 ? "attachment" : "attachments";
            throw new ChatSDKError(
              "bad_request:api",
              `Failed to prepare ${uploadResult.failedCount} local ${noun}. Please reattach and try again.`,
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

      await handleInitialChatAndUserMessage({
        chatId,
        userId,
        messages: messagesForPersistence,
        regenerate,
        chat: existingChat ?? null,
        isHidden: isAutoContinue ? true : undefined,
        projectId: projectContext.projectId,
      });

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
      // Trigger.dev's atomic Vercel integration pins the app and worker from the
      // same commit. Reuse that pin so Sessions cannot schedule an older worker.
      const approvalWorkerVersion =
        process.env.TRIGGER_VERSION?.trim() || undefined;
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
      const triggerIdempotencyKey = await buildAgentRunIdempotencyKey(
        triggerDedupeKeyParts,
      );
      const approvalSessionId = permissionSnapshot.requiresApprovalSession
        ? buildAgentApprovalSessionId({
            chatId,
            keyParts: triggerDedupeKeyParts,
            approvalProtocolVersion: AGENT_APPROVAL_PROTOCOL_VERSION,
            approvalWorkerVersion,
          })
        : undefined;
      if (
        approvalSessionId &&
        shouldRequireAgentApprovalWorkerVersion() &&
        !approvalWorkerVersion
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
        chatId,
        userId,
        subscription,
        organizationId,
        freeQuotaSubject,
        messages: messagesForPayload,
        localDesktopAttachmentsPrepared,
        baseTodos: Array.isArray(todos) ? todos : [],
        sandboxPreference,
        agentPermissionMode: permissionSnapshot.mode,
        approvalSessionId,
        approvalProtocolVersion: AGENT_APPROVAL_PROTOCOL_VERSION,
        selectedModel: selectedModelOverride,
        autoReviewAssignment,
        userLocation,
        triggerRegion,
        isAutoContinue,
        isAutomaticContinuation,
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
      const triggerMetadata = {
        status: "queued",
        chatId,
        userId,
        subscription,
        loginRequired: false,
        endpoint,
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
      const triggerPayloadTooLargeResponse = (
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

        return createAgentTriggerPayloadTooLargeResponse();
      };

      let runId: string;
      try {
        if (approvalSessionId) {
          const approvalTriggerConfig = {
            basePayload: agentPayload,
            machine: triggerMachine,
            tags: getAgentApprovalTriggerTags(triggerTags),
            region: triggerRegion,
            ...(approvalWorkerVersion
              ? { lockToVersion: approvalWorkerVersion }
              : {}),
          };
          const approvalSessionBody = {
            type: `agent-long-approval.v${AGENT_APPROVAL_PROTOCOL_VERSION}`,
            externalId: approvalSessionId,
            taskIdentifier: AGENT_TRIGGER_TASK_ID,
            tags: triggerTags,
            metadata: triggerMetadata,
            triggerConfig: approvalTriggerConfig,
          };
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
          const session = await sessions.start(approvalSessionBody);
          runId = session.runId;
        } else {
          if (
            isAgentTriggerRequestSizeTooLarge({
              payloadBytes: triggerPayloadBytes,
            })
          ) {
            return triggerPayloadTooLargeResponse("payload_limit_exceeded");
          }
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

      // Access-token creation and durable association are independent, so
      // overlap them while treating every post-start failure as terminal.
      const { publicAccessToken, approvalSessionPublicAccessToken } =
        await finalizeStartedAgentRun({
          chatId,
          runId,
          approvalSessionId,
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
      return handleAgentRouteError({
        error,
        endpoint,
        action: "start",
        fallbackMessage: "Failed to start agent run",
      });
    }
  };
