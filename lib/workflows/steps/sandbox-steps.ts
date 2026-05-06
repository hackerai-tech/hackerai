import { Sandbox } from "@e2b/code-interpreter";
import { RetryableError, getWritable } from "workflow";
import type { UIMessageChunk, UIMessagePart } from "ai";
import {
  saveMessage,
  setActiveWorkflowRun,
  updateChat,
} from "@/lib/db/actions";
import type { Id } from "@/convex/_generated/dataModel";

const SANDBOX_TIMEOUT_MS = 60 * 60 * 1000;
const SANDBOX_TEMPLATE = process.env.E2B_TEMPLATE || "terminal-agent-sandbox";

/**
 * Surface a fatal workflow error to the client by writing an AI SDK
 * `error` UI chunk to the default writable stream and closing it. Without
 * this, a workflow that aborts before any chunk is produced leaves the
 * HTTP SSE response hanging on the client.
 */
export async function emitWorkflowError(args: {
  errorText: string;
}): Promise<void> {
  "use step";
  const writer = getWritable<UIMessageChunk>().getWriter();
  try {
    await writer.write({ type: "error", errorText: args.errorText });
    await writer.close();
  } catch {
    // best-effort
  } finally {
    try {
      writer.releaseLock();
    } catch {
      // already released
    }
  }
}

/**
 * Persist the final assistant message produced by the workflow run, then
 * mark the chat with its finish reason. Best-effort: errors are logged to
 * the workflow stream but do not fail the workflow.
 */
export async function saveAssistantMessageStep(args: {
  chatId: string;
  userId: string;
  message: {
    id: string;
    role: "assistant";
    parts: UIMessagePart<any, any>[];
  };
  model?: string;
  finishReason?: string;
  extraFileIds?: Array<Id<"files">>;
}): Promise<{ saved: boolean }> {
  "use step";
  try {
    await saveMessage({
      chatId: args.chatId,
      userId: args.userId,
      message: args.message,
      model: args.model,
      finishReason: args.finishReason,
      extraFileIds: args.extraFileIds,
    });
    if (args.finishReason) {
      await updateChat({
        chatId: args.chatId,
        finishReason: args.finishReason,
      });
    }
    await setActiveWorkflowRun({ chatId: args.chatId, runId: null });
    return { saved: true };
  } catch (error) {
    console.error("[workflow] saveAssistantMessageStep failed", error);
    try {
      await setActiveWorkflowRun({ chatId: args.chatId, runId: null });
    } catch {
      // ignore
    }
    return { saved: false };
  }
}

/**
 * Clear the active workflow run id without saving a message. Used by the
 * workflow's catch handler so a refresh after a failed run doesn't try to
 * reattach to a dead stream.
 */
export async function clearActiveWorkflowRunStep(args: {
  chatId: string;
}): Promise<void> {
  "use step";
  await setActiveWorkflowRun({ chatId: args.chatId, runId: null });
}

export async function startSandbox(args: {
  userId: string;
  chatId: string;
}): Promise<{ sandboxId: string }> {
  "use step";
  const sbx = await Sandbox.create(SANDBOX_TEMPLATE, {
    timeoutMs: SANDBOX_TIMEOUT_MS,
    metadata: {
      userId: args.userId,
      chatId: args.chatId,
      origin: "workflow",
    },
  });
  return { sandboxId: sbx.sandboxId };
}

export async function killSandbox(args: {
  sandboxId: string;
}): Promise<{ killed: boolean }> {
  "use step";
  try {
    await Sandbox.kill(args.sandboxId);
    return { killed: true };
  } catch {
    return { killed: false };
  }
}
