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
    const helperIdx = convexChatsSrc.indexOf(
      "async function deleteChatDocument",
    );
    const publishCallIdx = convexChatsSrc.indexOf(
      "await publishDeletionCancellation(ctx, chat.id)",
      helperIdx,
    );
    const deleteChatRowIdx = convexChatsSrc.indexOf(
      "await ctx.db.delete(chat._id)",
      helperIdx,
    );

    expect(publishHelperIdx).toBeGreaterThan(-1);
    expect(redisPublishIdx).toBeGreaterThan(publishHelperIdx);
    expect(skipSaveIdx).toBeGreaterThan(redisPublishIdx);
    expect(helperIdx).toBeGreaterThan(-1);
    expect(publishCallIdx).toBeGreaterThan(helperIdx);
    expect(deleteChatRowIdx).toBeGreaterThan(publishCallIdx);
  });
});
