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

    if (!temporary) {
      await handleInitialChatAndUserMessage({
        chatId,
        userId,
        messages,
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
        messages,
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
