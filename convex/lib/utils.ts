import { GenericDatabaseWriter } from "convex/server";
import type { DataModel } from "../_generated/dataModel";
import { Id } from "../_generated/dataModel";
import type { RetainedTailDoc } from "./retainedTail";

export function validateServiceKey(serviceKey: string): void {
  if (serviceKey !== process.env.CONVEX_SERVICE_ROLE_KEY) {
    throw new Error("Unauthorized: Invalid service key");
  }
}

const remapRetainedTail = (
  retainedTail: RetainedTailDoc | undefined,
  messageIdMap: Map<string, string>,
): RetainedTailDoc | undefined => {
  if (!retainedTail) return undefined;

  const remappedStartMessageId = messageIdMap.get(
    retainedTail.start_message_id,
  );
  if (!remappedStartMessageId) return undefined;

  return {
    ...retainedTail,
    start_message_id: remappedStartMessageId,
  };
};

/**
 * Copy a chat's summary to a new chat, remapping message IDs.
 * No-ops gracefully if the summary doesn't exist or doesn't cover copied messages.
 */
export async function copyChatSummary(
  db: GenericDatabaseWriter<DataModel>,
  opts: {
    sourceSummaryId: Id<"chat_summaries">;
    targetChatDocId: Id<"chats">;
    targetChatId: string;
    messageIdMap: Map<string, string>;
  },
): Promise<void> {
  try {
    const summary = await db.get(opts.sourceSummaryId);
    if (!summary) return;

    const remappedId = opts.messageIdMap.get(summary.summary_up_to_message_id);
    if (!remappedId) return;

    const remappedPrevious = (summary.previous_summaries ?? [])
      .filter((s) => opts.messageIdMap.has(s.summary_up_to_message_id))
      .map((s) => {
        const retainedTail = remapRetainedTail(
          s.retained_tail as RetainedTailDoc | undefined,
          opts.messageIdMap,
        );
        return {
          summary_text: s.summary_text,
          summary_up_to_message_id: opts.messageIdMap.get(
            s.summary_up_to_message_id,
          )!,
          ...(retainedTail ? { retained_tail: retainedTail } : {}),
        };
      });

    const metadata = Object.fromEntries(
      Object.entries({
        reason: summary.reason,
        prompt_version: summary.prompt_version,
        model: summary.model,
        status: summary.status,
        error: summary.error,
        transcript_path: summary.transcript_path,
        retained_tail: remapRetainedTail(
          summary.retained_tail as RetainedTailDoc | undefined,
          opts.messageIdMap,
        ),
      }).filter(([, value]) => value !== undefined),
    );

    const summaryId = await db.insert("chat_summaries", {
      chat_id: opts.targetChatId,
      summary_text: summary.summary_text,
      summary_up_to_message_id: remappedId,
      ...metadata,
      previous_summaries: remappedPrevious,
    });

    await db.patch(opts.targetChatDocId, { latest_summary_id: summaryId });
  } catch (error) {
    // Summary copying is not critical — the chat works without it
    console.error("Failed to copy summary:", error);
  }
}
