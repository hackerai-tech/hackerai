import { NextRequest, NextResponse } from "next/server";
import { tasks, auth } from "@trigger.dev/sdk";
import type { agentLongTask } from "@/trigger/agent-long";
import { geolocation } from "@vercel/functions";
import type { UIMessage } from "ai";

import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import {
  getChatById,
  handleInitialChatAndUserMessage,
  setActiveTriggerRun,
} from "@/lib/db/actions";
import { assertFreeAgentGates } from "@/lib/api/chat-stream-helpers";
import { coerceSelectedModel } from "@/types";
import { ChatSDKError } from "@/lib/errors";
import type { Todo, SandboxPreference, SelectedModel } from "@/types";
import { HybridSandboxManager } from "@/lib/ai/tools/utils/hybrid-sandbox-manager";
import {
  getUploadBasePath,
  hasLocalDesktopSourcePaths,
  prepareLocalDesktopAttachmentsForTrigger,
  stripLocalDesktopSourcePaths,
  uploadSandboxFiles,
} from "@/lib/utils/sandbox-file-utils";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const {
      messages,
      chatId,
      todos,
      regenerate,
      temporary,
      sandboxPreference,
      selectedModel: rawSelectedModel,
      isAutoContinue,
    }: {
      messages: UIMessage[];
      chatId: string;
      todos?: Todo[];
      regenerate?: boolean;
      temporary?: boolean;
      sandboxPreference?: SandboxPreference;
      selectedModel?: string;
      isAutoContinue?: boolean;
    } = await req.json();

    const selectedModelOverride: SelectedModel | undefined =
      coerceSelectedModel(rawSelectedModel ?? null) ?? undefined;

    const { userId, subscription, organizationId } = await getUserIDAndPro(req);
    await assertUserCanMakeCostIncurringRequest(userId);
    const userLocation = geolocation(req);

    assertFreeAgentGates({
      mode: "agent",
      subscription,
      sandboxPreference,
      rawSelectedModel,
    });

    // Fetch existing chat to: (a) detect isNewChat for title generation,
    // (b) pass to handleInitialChatAndUserMessage so it skips saveChat on
    //     regenerate/auto-continue and does the ownership check instead.
    const existingChat = temporary ? null : await getChatById({ id: chatId });
    const isNewChat =
      !temporary && !existingChat && !regenerate && !isAutoContinue;

    let messagesForPersistence = stripLocalDesktopSourcePaths(messages);
    let messagesForTrigger = messagesForPersistence;
    let localDesktopAttachmentsPrepared = false;

    if (hasLocalDesktopSourcePaths(messages)) {
      if (sandboxPreference !== "desktop") {
        throw new ChatSDKError(
          "bad_request:api",
          "Desktop-local attachments can only be used with the desktop sandbox.",
        );
      }

      const { messages: preparedMessages, sandboxFiles } =
        prepareLocalDesktopAttachmentsForTrigger(
          messages,
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
        let stagedSandbox: any = null;
        const uploadResult = await uploadSandboxFiles(
          sandboxFiles,
          async () => {
            const { sandbox } = await sandboxManager.getSandbox();
            stagedSandbox = sandbox;
            return sandbox;
          },
        );
        await stagedSandbox?.close?.().catch(() => {});
        if (uploadResult.failedCount > 0) {
          const noun =
            uploadResult.failedCount === 1 ? "attachment" : "attachments";
          throw new ChatSDKError(
            "bad_request:api",
            `Failed to prepare ${uploadResult.failedCount} local ${noun}. Please reattach and try again.`,
          );
        }
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

    const handle = await tasks.trigger<typeof agentLongTask>(
      "agent-long",
      {
        chatId,
        userId,
        subscription,
        organizationId,
        messages: messagesForTrigger,
        localDesktopAttachmentsPrepared,
        baseTodos: Array.isArray(todos) ? todos : [],
        sandboxPreference,
        selectedModel: selectedModelOverride,
        userLocation,
        temporary,
        isAutoContinue,
        regenerate,
        isNewChat,
        convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
      },
      {
        tags: triggerTags,
        metadata: {
          status: "queued",
          chatId,
          userId,
          subscription,
          loginRequired: false,
        },
      },
    );

    if (!temporary) {
      await setActiveTriggerRun({ chatId, triggerRunId: handle.id });
    }

    // Public access token scoped to this run only — the client uses it to
    // subscribe to the realtime stream without ever seeing TRIGGER_SECRET_KEY.
    const publicAccessToken = await auth.createPublicToken({
      scopes: { read: { runs: [handle.id] } },
      // 6h is enough to cover the 1h max task duration plus reconnect grace.
      expirationTime: "6h",
    });

    return NextResponse.json({
      runId: handle.id,
      publicAccessToken,
    });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    console.error("[/api/agent-long] failed to trigger task:", error);
    return new NextResponse("Failed to start agent-long run", { status: 500 });
  }
}
