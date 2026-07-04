import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import * as triggerSdk from "@trigger.dev/sdk";
import { tasks, auth } from "@trigger.dev/sdk";
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
import { getTriggerRegionForVercelRequest } from "@/lib/api/trigger-region";
import {
  coerceSelectedModel,
  coerceAgentPermissionMode,
  normalizeSelectedModelOverrideForSubscription,
} from "@/types";
import { ChatSDKError } from "@/lib/errors";
import type {
  Todo,
  SandboxPreference,
  SelectedModel,
  SubscriptionTier,
  AgentPermissionMode,
} from "@/types";
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

export const maxDuration = 30;

const AGENT_LONG_TRIGGER_PRIORITY_BY_SUBSCRIPTION: Record<
  SubscriptionTier,
  number
> = {
  free: 0,
  pro: 5,
  "pro-plus": 5,
  ultra: 10,
  team: 5,
};

const getAgentLongTriggerPriority = (subscription: SubscriptionTier) =>
  AGENT_LONG_TRIGGER_PRIORITY_BY_SUBSCRIPTION[subscription];

type TriggerSessionsApi = {
  start(body: Record<string, unknown>): Promise<{
    runId: string;
    publicAccessToken?: string;
  }>;
};

const triggerSessions = (
  triggerSdk as unknown as { sessions?: TriggerSessionsApi }
).sessions;

export async function POST(req: NextRequest) {
  const routeStartedAt = Date.now();
  try {
    const {
      messages,
      chatId,
      todos,
      regenerate,
      temporary,
      sandboxPreference,
      agentPermissionMode: rawAgentPermissionMode,
      selectedModel: rawSelectedModel,
      isAutoContinue,
    }: {
      messages: UIMessage[];
      chatId: string;
      todos?: Todo[];
      regenerate?: boolean;
      temporary?: boolean;
      sandboxPreference?: SandboxPreference;
      agentPermissionMode?: AgentPermissionMode;
      selectedModel?: string;
      isAutoContinue?: boolean;
    } = await req.json();
    const agentPermissionMode = coerceAgentPermissionMode(
      rawAgentPermissionMode,
    );

    const { userId, subscription, organizationId, freeQuotaSubject } =
      await getUserIDAndPro(req);
    let selectedModelOverride: SelectedModel | undefined =
      normalizeSelectedModelOverrideForSubscription(
        coerceSelectedModel(rawSelectedModel ?? null),
        subscription,
      );
    await assertUserCanMakeCostIncurringRequest(userId);
    const userLocation = geolocation(req);
    const triggerRegion = getTriggerRegionForVercelRequest(req);

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
          event: "agent_long_empty_message_payload_rejected",
          service: "chat-handler",
          timestamp: new Date().toISOString(),
          chat_id: chatId,
          user_id: userId,
          temporary: !!temporary,
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

    // Fetch existing chat to: (a) detect isNewChat for title generation,
    // (b) pass to handleInitialChatAndUserMessage so it skips saveChat on
    //     regenerate/auto-continue and does the ownership check instead.
    const existingChat = temporary ? null : await getChatById({ id: chatId });
    const isNewChat =
      !temporary && !existingChat && !regenerate && !isAutoContinue;
    const userCustomization = await getUserCustomization({ userId });
    const extraUsageConfig = await buildExtraUsageConfig({
      userId,
      subscription,
      userCustomization,
      organizationId,
    });
    selectedModelOverride = resolveAgentRunSpendCapContinuationModel({
      finishReason: existingChat?.finish_reason,
      isAutoContinue,
      mode: "agent",
      subscription,
      selectedModelOverride,
      extraUsageConfig,
    });

    let messagesForPersistence = stripLocalDesktopSourcePaths(requestMessages);
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

    if (!temporary) {
      await handleInitialChatAndUserMessage({
        chatId,
        userId,
        messages: messagesForPersistence,
        regenerate,
        chat: existingChat ?? null,
        isHidden: isAutoContinue ? true : undefined,
      });
    }

    const triggerTags = [`user_${userId}`, `chat_${chatId}`];
    if (subscription !== "free") triggerTags.push(`sub_${subscription}`);

    // Persisted chats are rehydrated from Convex inside the task after the
    // route saves the latest user message. Avoid sending the same history
    // through Trigger unless the task cannot rehydrate it, or the route has
    // prepared desktop-local attachment tags that only exist in this payload.
    const messagesForPayload =
      temporary || localDesktopAttachmentsPrepared ? messagesForTrigger : [];

    const triggerRequestedAt = Date.now();
    const triggerPriority = getAgentLongTriggerPriority(subscription);
    const approvalSessionId =
      agentPermissionMode === "ask_approval"
        ? `agent-approval:${chatId}:${randomUUID()}`
        : undefined;
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
      agentPermissionMode,
      approvalSessionId,
      selectedModel: selectedModelOverride,
      userLocation,
      temporary,
      isAutoContinue,
      regenerate,
      isNewChat,
      convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
      requestTiming: {
        routeStartedAt,
        triggerRequestedAt,
      },
    };
    const triggerMetadata = {
      status: "queued",
      chatId,
      userId,
      subscription,
      loginRequired: false,
      routeStartedAt,
      triggerRequestedAt,
      triggerPriority,
      triggerPayloadMessageCount: messagesForPayload.length,
      agentPermissionMode,
      ...(approvalSessionId ? { approvalSessionId } : {}),
    };
    const triggerOptions = {
      ...(triggerPriority > 0 ? { priority: triggerPriority } : {}),
      tags: triggerTags,
      ...(triggerRegion ? { region: triggerRegion } : {}),
      metadata: triggerMetadata,
    };

    let runId: string;
    let approvalSessionPublicAccessToken: string | undefined;

    if (approvalSessionId) {
      if (!triggerSessions) {
        throw new Error("Trigger.dev Sessions API is unavailable.");
      }

      const session = await triggerSessions.start({
        type: "agent-long-approval",
        externalId: approvalSessionId,
        taskIdentifier: "agent-long",
        tags: triggerTags,
        metadata: triggerMetadata,
        triggerConfig: {
          basePayload: agentPayload,
          tags: triggerTags,
        },
      });
      runId = session.runId;
      approvalSessionPublicAccessToken =
        session.publicAccessToken ??
        (await auth.createPublicToken({
          scopes: {
            read: { sessions: approvalSessionId },
            write: { sessions: approvalSessionId },
          } as any,
          expirationTime: "6h",
        }));
    } else {
      const handle = await tasks.trigger<typeof agentLongTask>(
        "agent-long",
        agentPayload,
        triggerOptions,
      );
      runId = handle.id;
    }

    const triggerCompletedAt = Date.now();

    // Public access token scoped to this run only — the client uses it to
    // subscribe to the realtime stream without ever seeing TRIGGER_SECRET_KEY.
    // Updating Convex with the active run id is independent, so overlap both
    // network calls before returning the handle to the browser.
    const [publicAccessToken] = await Promise.all([
      auth.createPublicToken({
        scopes: { read: { runs: [runId] } },
        // 6h is enough to cover the max task duration plus reconnect grace.
        expirationTime: "6h",
      }),
      temporary
        ? Promise.resolve(null)
        : setActiveTriggerRun({
            chatId,
            triggerRunId: runId,
            approvalSessionId: approvalSessionId ?? null,
          }),
    ]);

    console.info("[/api/agent-long] started trigger run", {
      chatId,
      runId,
      routeDurationMs: Date.now() - routeStartedAt,
      triggerDurationMs: triggerCompletedAt - triggerRequestedAt,
      triggerPayloadMessageCount: messagesForPayload.length,
      persistedMessageCount: messagesForPersistence.length,
      temporary: !!temporary,
      localDesktopAttachmentsPrepared,
      agentPermissionMode,
    });

    return NextResponse.json({
      runId,
      publicAccessToken,
      chatId,
      ...(approvalSessionId && approvalSessionPublicAccessToken
        ? {
            approvalSessionId,
            approvalSessionPublicAccessToken,
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    console.error("[/api/agent-long] failed to trigger task:", error);
    return new NextResponse("Failed to start agent-long run", { status: 500 });
  }
}
