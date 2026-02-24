import { logger } from "@trigger.dev/sdk/v3";
import type { UIMessage } from "ai";
import {
  saveMessage,
  updateChat,
  prepareForNewStream,
  deleteTempStreamForBackend,
} from "@/lib/db/actions";
import type { AgentStreamContext } from "./context";
import type { AccumulatedFileMetadata } from "@/lib/ai/tools/utils/file-accumulator";

export type StreamFinishArgs = {
  messages: UIMessage[];
  isAborted: boolean;
};

function sendFileMetadataToStream(
  context: AgentStreamContext,
  fileMetadata: Array<AccumulatedFileMetadata>,
) {
  if (!fileMetadata?.length) return;
  context.appendMetadata({
    type: "data-file-metadata",
    data: {
      messageId: context.payload.assistantMessageId,
      fileDetails: fileMetadata,
    },
  });
}

export async function handleAgentStreamFinish(
  context: AgentStreamContext,
  { messages, isAborted }: StreamFinishArgs,
): Promise<void> {
  try {
    const generatedTitle = await context.titlePromise;
    const {
      chatId,
      userId,
      temporary,
      regenerate,
      todos: baseTodos,
      assistantMessageId,
      mode,
    } = context.payload;
    const {
      getTodoManager,
      getFileAccumulator,
      sandboxManager,
      summarizationParts,
      streamFinishReason,
      responseModel,
      configuredModelId,
      streamStartTime,
      streamUsage,
      hasSummarized,
    } = context;

    if (!temporary) {
      const mergedTodos = getTodoManager().mergeWith(
        baseTodos,
        assistantMessageId,
      );
      const shouldPersist =
        regenerate ||
        !!generatedTitle ||
        !!streamFinishReason ||
        mergedTodos.length > 0;
      if (shouldPersist) {
        await updateChat({
          chatId,
          title: generatedTitle,
          finishReason: streamFinishReason,
          todos: mergedTodos,
          defaultModelSlug: mode,
          sandboxType: sandboxManager.getEffectivePreference(),
        });
      } else {
        await prepareForNewStream({ chatId });
      }
      const accumulatedFiles = getFileAccumulator().getAll();
      const newFileIds = accumulatedFiles.map((f) => f.fileId);
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        const processedMessage =
          summarizationParts.length > 0
            ? {
                ...message,
                parts: [...summarizationParts, ...(message.parts || [])],
              }
            : message;
        await saveMessage({
          chatId,
          userId,
          message: processedMessage,
          extraFileIds: newFileIds,
          model: responseModel || configuredModelId,
          generationTimeMs: Date.now() - streamStartTime,
          finishReason: streamFinishReason,
          usage: streamUsage,
        });
      }
      sendFileMetadataToStream(context, accumulatedFiles);
    } else {
      const tempFiles = getFileAccumulator().getAll();
      sendFileMetadataToStream(context, tempFiles);
      await deleteTempStreamForBackend({ chatId });
    }
    await context.deductAccumulatedUsage();

    context.chatLogger.setSandbox(sandboxManager.getSandboxInfo());
    context.chatLogger.emitSuccess({
      finishReason: streamFinishReason,
      wasAborted: !!isAborted,
      wasPreemptiveTimeout: false,
      hadSummarization: hasSummarized,
    });
  } catch (error) {
    logger.error("onFinish failed", {
      chatId: context.payload.chatId,
      userId: context.payload.userId,
      mode: context.payload.mode,
      error,
    });
  }
}
