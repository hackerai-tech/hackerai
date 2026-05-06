import { NextRequest } from "next/server";
import { start } from "workflow/api";
import { JsonToSseTransformStream, type UIMessage } from "ai";
import { geolocation } from "@vercel/functions";
import { agentRunWorkflow } from "@/lib/workflows/agent-run";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import { selectModel } from "@/lib/chat/chat-processor";
import { isSelectedModel, type SelectedModel } from "@/types/chat";
import {
  getChatById,
  getMessagesByChatId,
  getUserCustomization,
  handleInitialChatAndUserMessage,
  setActiveWorkflowRun,
  updateChat,
} from "@/lib/db/actions";
import { processChatMessages } from "@/lib/chat/chat-processor";
import { getUploadBasePath } from "@/lib/utils/sandbox-file-utils";
import type { Todo } from "@/types";

export const runtime = "nodejs";
export const maxDuration = 800;

interface WorkflowRequestBody {
  chatId?: string;
  messages?: UIMessage[];
  selectedModel?: string;
  regenerate?: boolean;
}

export async function POST(req: NextRequest) {
  let auth: Awaited<ReturnType<typeof getUserIDAndPro>>;
  try {
    auth = await getUserIDAndPro(req);
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
    return new ChatSDKError("unauthorized:auth").toResponse();
  }

  if (auth.subscription === "free") {
    return new ChatSDKError(
      "forbidden:chat",
      "Long-running workflow mode requires a Pro plan.",
    ).toResponse();
  }

  let body: WorkflowRequestBody;
  try {
    body = (await req.json()) as WorkflowRequestBody;
  } catch {
    return new ChatSDKError(
      "bad_request:api",
      "Invalid JSON body",
    ).toResponse();
  }

  if (!body.chatId) {
    return new ChatSDKError("bad_request:api", "Missing chatId").toResponse();
  }

  const isRegenerate = body.regenerate === true;
  const incomingMessages = body.messages ?? [];

  if (!isRegenerate && incomingMessages.length === 0) {
    return new ChatSDKError(
      "bad_request:api",
      "No user message in request",
    ).toResponse();
  }

  const selectedModelOverride: SelectedModel | undefined =
    body.selectedModel && isSelectedModel(body.selectedModel)
      ? body.selectedModel
      : undefined;
  const resolvedModel = selectModel(
    "agent",
    auth.subscription,
    selectedModelOverride,
  );

  // Fetch the full chat history from the DB and merge it with the new user
  // message (the client only sends the latest turn for non-temporary chats).
  // Without this the workflow would see only a single user message and the
  // agent would be amnesiac across turns. Mirrors the chat-handler pattern.
  let truncatedMessages: UIMessage[];
  let existingChat: Awaited<ReturnType<typeof getChatById>>;
  try {
    const fetched = await getMessagesByChatId({
      chatId: body.chatId,
      userId: auth.userId,
      subscription: auth.subscription,
      newMessages: incomingMessages,
      regenerate: isRegenerate,
      isTemporary: false,
      mode: "agent-long",
    });
    truncatedMessages = fetched.truncatedMessages;
    existingChat = fetched.chat ?? null;

    if (isRegenerate && !existingChat) {
      return new ChatSDKError(
        "not_found:chat",
        "Chat not found for regeneration",
      ).toResponse();
    }

    // Persist chat row + new user message before starting the workflow so the
    // chat is visible immediately in the UI and survives reload/navigation
    // even if the workflow run errors midway. handleInitialChatAndUserMessage
    // saves only the LAST message in the array; on regenerate it skips the
    // save entirely (the user message already exists in the DB).
    await handleInitialChatAndUserMessage({
      chatId: body.chatId,
      userId: auth.userId,
      messages: truncatedMessages,
      regenerate: isRegenerate,
      chat: existingChat,
    });
    await updateChat({
      chatId: body.chatId,
      defaultModelSlug: "agent-long",
      selectedModel: body.selectedModel ?? "auto",
    });
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
    return new ChatSDKError(
      "bad_request:database",
      `Failed to initialize chat: ${error instanceof Error ? error.message : String(error)}`,
    ).toResponse();
  }

  // Run the same message-processing pipeline as the regular chat handler so
  // prior assistant turns with tool invocations / file parts / provider
  // metadata are normalized before they reach the agent.
  const { processedMessages } = await processChatMessages({
    messages: truncatedMessages,
    mode: "agent-long",
    subscription: auth.subscription,
    uploadBasePath: getUploadBasePath("e2b"),
    modelOverride: selectedModelOverride,
  });

  if (!processedMessages || processedMessages.length === 0) {
    return new ChatSDKError(
      "bad_request:api",
      "Your message could not be processed. Please include some text with your file attachments and try again.",
    ).toResponse();
  }

  // Fetch user customization once so the workflow input is fully self-contained
  // (system prompt, guardrails, memory gating). Failure here is non-fatal —
  // we fall through with sensible defaults (no guardrails, memory enabled).
  const userCustomization = await getUserCustomization({
    userId: auth.userId,
  }).catch(() => null);

  // Free subscription was rejected at the start of the handler; everything
  // here runs as a paid tier where memory is always available subject to
  // the user's customization preference.
  const memoryEnabled = userCustomization?.include_memory_entries ?? true;

  const userLocationCountry = geolocation(req)?.country;

  // Seed TodoManager from the chat row so multi-turn runs preserve todos
  // (matches what `chat-handler.ts` does via `getBaseTodosForRequest`).
  const initialTodos = existingChat?.todos as Todo[] | undefined;

  const run = await start(agentRunWorkflow, [
    {
      userId: auth.userId,
      chatId: body.chatId,
      messages: processedMessages,
      model: resolvedModel,
      subscription: auth.subscription,
      userCustomization,
      guardrailsConfig: userCustomization?.guardrails_config,
      memoryEnabled,
      userLocationCountry,
      initialTodos,
    },
  ]);

  // Persist runId on the chat so a browser refresh can rediscover the live
  // stream via /api/workflow/[runId]/stream.
  await setActiveWorkflowRun({ chatId: body.chatId, runId: run.runId });

  const objectStream = run.getReadable({ startIndex: 0 });
  const sseStream = objectStream.pipeThrough(new JsonToSseTransformStream());

  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Transfer-Encoding": "chunked",
      "X-Accel-Buffering": "no",
      "x-workflow-run-id": run.runId,
    },
  });
}
