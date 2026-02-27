import { saveErrorMessageWithTodos } from "@/lib/db/actions";
import type { AgentTaskPayload } from "@/lib/api/prepare-agent-payload";
import {
  getChunks,
  clearChunks,
  ERROR_NOTICE_MARKER,
  getTodoState,
  clearTodoState,
} from "./chunk-store";
import { accumulateChunksToMessage } from "@/lib/utils/accumulate-ui-chunks";

export async function handleCatchError({
  payload,
  error,
}: {
  payload: AgentTaskPayload;
  error: unknown;
}) {
  const chunks = getChunks(payload.chatId);
  if (chunks.length === 0 || payload.temporary) return;

  const partialMessage = accumulateChunksToMessage(
    chunks,
    payload.assistantMessageId,
  );

  const lastTextIdx = partialMessage.parts.findLastIndex(
    (p) => p.type === "text",
  );
  if (lastTextIdx >= 0) {
    const lastTextPart = partialMessage.parts[lastTextIdx];
    if (lastTextPart.type === "text") {
      lastTextPart.text += ERROR_NOTICE_MARKER;
    }
  } else {
    partialMessage.parts.push({
      type: "text",
      text: ERROR_NOTICE_MARKER,
      state: "done",
    });
  }

  const todos = getTodoState(payload.chatId);

  try {
    await saveErrorMessageWithTodos({
      chatId: payload.chatId,
      userId: payload.userId,
      message: partialMessage,
      todos: todos.length > 0 ? todos : undefined,
    });
    clearChunks(payload.chatId);
    clearTodoState(payload.chatId);
  } catch (saveError) {
    console.error("catchError: failed to save error state", saveError);
    return { skipRetrying: true };
  }

  if (error instanceof Error && error.message === "SimulatedRetryError") {
    return;
  }
}
