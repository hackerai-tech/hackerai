import fs from "fs";
import path from "path";

const convexChatsSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../convex/chats.ts"),
  "utf8",
);

const chatDeleteRouteSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../app/api/chat/[id]/route.ts"),
  "utf8",
);

const chatsDeleteRouteSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../app/api/chats/route.ts"),
  "utf8",
);

const dataControlsTabSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../app/components/DataControlsTab.tsx"),
  "utf8",
);

describe("chat deletion cancellation contracts", () => {
  test("server delete route cancels Trigger runs before deleting the chat row", () => {
    const runIdIdx = chatDeleteRouteSrc.indexOf(
      "const triggerRunId = chat.active_trigger_run_id",
    );
    const cancelIdx = chatDeleteRouteSrc.indexOf(
      "runs.cancel(triggerRunId)",
      runIdIdx,
    );
    const deleteIdx = chatDeleteRouteSrc.indexOf(
      "deleteChatForBackend({",
      cancelIdx,
    );

    expect(runIdIdx).toBeGreaterThan(-1);
    expect(cancelIdx).toBeGreaterThan(runIdIdx);
    expect(deleteIdx).toBeGreaterThan(cancelIdx);
  });

  test("settings delete-all route cancels Trigger runs before deleting chats", () => {
    const lookupIdx = chatsDeleteRouteSrc.indexOf(
      "getActiveTriggerRunsForUser({ userId })",
    );
    const cancelIdx = chatsDeleteRouteSrc.indexOf(
      "await cancelTriggerRuns(triggerRunIds)",
      lookupIdx,
    );
    const deleteIdx = chatsDeleteRouteSrc.indexOf(
      "deleteAllChatsForBackend({ userId })",
      cancelIdx,
    );

    expect(lookupIdx).toBeGreaterThan(-1);
    expect(cancelIdx).toBeGreaterThan(lookupIdx);
    expect(deleteIdx).toBeGreaterThan(cancelIdx);
  });

  test("settings delete-all UI uses the cancellation-aware server route", () => {
    expect(dataControlsTabSrc).toContain('fetch("/api/chats"');
    expect(dataControlsTabSrc).not.toContain("api.chats.deleteAllChats");
  });

  test("Convex chat deletion publishes stream cancellation before deleting the chat row", () => {
    const publishHelperIdx = convexChatsSrc.indexOf(
      "async function publishDeletionCancellation",
    );
    const redisPublishIdx = convexChatsSrc.indexOf(
      "internal.redisPubsub.publishCancellation",
      publishHelperIdx,
    );
    const skipSaveIdx = convexChatsSrc.indexOf(
      "skipSave: true",
      redisPublishIdx,
    );
    const prepareHelperIdx = convexChatsSrc.indexOf(
      "async function prepareChatForDeletion",
    );
    const publishCallIdx = convexChatsSrc.indexOf(
      "await publishDeletionCancellation(ctx, chat.id)",
      prepareHelperIdx,
    );
    const helperIdx = convexChatsSrc.indexOf(
      "async function deleteChatDocument",
    );
    const prepareCallIdx = convexChatsSrc.indexOf(
      "await prepareChatForDeletion(ctx, chat)",
      helperIdx,
    );
    const deleteChatRowIdx = convexChatsSrc.indexOf(
      "await ctx.db.delete(chat._id)",
      helperIdx,
    );

    expect(publishHelperIdx).toBeGreaterThan(-1);
    expect(redisPublishIdx).toBeGreaterThan(publishHelperIdx);
    expect(skipSaveIdx).toBeGreaterThan(redisPublishIdx);
    expect(prepareHelperIdx).toBeGreaterThan(-1);
    expect(publishCallIdx).toBeGreaterThan(prepareHelperIdx);
    expect(helperIdx).toBeGreaterThan(-1);
    expect(prepareCallIdx).toBeGreaterThan(helperIdx);
    expect(deleteChatRowIdx).toBeGreaterThan(prepareCallIdx);
  });

  test("Convex single-chat deletion uses bounded scheduled batches", () => {
    const scheduleHelperIdx = convexChatsSrc.indexOf(
      "async function scheduleDeleteChatDocumentBatch",
    );
    const internalBatchIdx = convexChatsSrc.indexOf(
      "internal.chats.deleteChatForBackendBatch",
      scheduleHelperIdx,
    );
    const helperIdx = convexChatsSrc.indexOf(
      "async function deleteChatDocument",
    );
    const collectIdx = convexChatsSrc.indexOf(".collect()", helperIdx);
    const messageTakeIdx = convexChatsSrc.indexOf(
      ".take(DELETE_ALL_CHATS_MESSAGE_BATCH_SIZE + 1)",
      helperIdx,
    );
    const scheduleCallIdx = convexChatsSrc.indexOf(
      "await scheduleDeleteChatDocumentBatch(ctx, chat.id, chat.user_id)",
      messageTakeIdx,
    );
    const summaryTakeIdx = convexChatsSrc.indexOf(
      ".take(DELETE_ALL_CHATS_SUMMARY_BATCH_SIZE + 1)",
      scheduleCallIdx,
    );
    const internalMutationIdx = convexChatsSrc.indexOf(
      "export const deleteChatForBackendBatch = internalMutation",
    );

    expect(scheduleHelperIdx).toBeGreaterThan(-1);
    expect(internalBatchIdx).toBeGreaterThan(scheduleHelperIdx);
    expect(helperIdx).toBeGreaterThan(-1);
    expect(messageTakeIdx).toBeGreaterThan(helperIdx);
    expect(scheduleCallIdx).toBeGreaterThan(messageTakeIdx);
    expect(summaryTakeIdx).toBeGreaterThan(scheduleCallIdx);
    expect(internalMutationIdx).toBeGreaterThan(-1);
    expect(collectIdx === -1 || collectIdx > internalMutationIdx).toBe(true);
  });

  test("Convex delete-all batches prepare each chat for cancellation before deleting messages", () => {
    const batchHelperIdx = convexChatsSrc.indexOf(
      "async function deleteNextUserChatBatch",
    );
    const prepareCallIdx = convexChatsSrc.indexOf(
      "await prepareChatForDeletion(ctx, chat)",
      batchHelperIdx,
    );
    const messagesQueryIdx = convexChatsSrc.indexOf(
      '.query("messages")',
      batchHelperIdx,
    );

    expect(batchHelperIdx).toBeGreaterThan(-1);
    expect(prepareCallIdx).toBeGreaterThan(batchHelperIdx);
    expect(messagesQueryIdx).toBeGreaterThan(prepareCallIdx);
  });
});
