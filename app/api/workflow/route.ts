import { NextRequest } from "next/server";
import { start } from "workflow/api";
import { JsonToSseTransformStream, type UIMessage } from "ai";
import { agentRunWorkflow } from "@/lib/workflows/agent-run";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import { selectModel } from "@/lib/chat/chat-processor";
import { isSelectedModel, type SelectedModel } from "@/types/chat";
import {
  getChatById,
  handleInitialChatAndUserMessage,
  setActiveWorkflowRun,
  updateChat,
} from "@/lib/db/actions";

export const runtime = "nodejs";
export const maxDuration = 800;

interface WorkflowRequestBody {
  chatId?: string;
  messages?: UIMessage[];
  mode?: string;
  selectedModel?: string;
  prompt?: string;
}

function extractPrompt(body: WorkflowRequestBody): string | null {
  if (typeof body.prompt === "string" && body.prompt.trim()) return body.prompt;
  const messages = body.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    const parts = (msg as { parts?: Array<{ type: string; text?: string }> })
      .parts;
    if (Array.isArray(parts)) {
      const text = parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string" && content.trim()) return content;
  }
  return null;
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

  const prompt = extractPrompt(body);
  if (!prompt) {
    return new ChatSDKError(
      "bad_request:api",
      "Could not derive a user prompt from the request",
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

  // Persist chat row + user message before starting the workflow so the
  // chat is visible immediately in the UI and survives reload/navigation
  // even if the workflow run errors midway.
  const lastUserMessage = (body.messages ?? [])
    .slice()
    .reverse()
    .find((m) => m.role === "user");
  if (!lastUserMessage) {
    return new ChatSDKError(
      "bad_request:api",
      "No user message in request",
    ).toResponse();
  }
  try {
    const existingChat = await getChatById({ id: body.chatId });
    await handleInitialChatAndUserMessage({
      chatId: body.chatId,
      userId: auth.userId,
      messages: [
        {
          id: lastUserMessage.id,
          parts: (lastUserMessage as { parts: any[] }).parts ?? [],
        },
      ],
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

  const run = await start(agentRunWorkflow, [
    {
      userId: auth.userId,
      chatId: body.chatId,
      prompt,
      model: resolvedModel,
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
