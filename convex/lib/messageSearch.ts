import type { WithoutSystemFields } from "convex/server";
import { ConvexError, getDocumentSize } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./serviceFunctions";

type Message = Doc<"messages">;

export const extractMessageText = (parts: any[]): string =>
  parts
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join(" ")
    .trim();

// Readers that already need parts must not fetch another document for text.
export const messageDisplayText = (
  message: Pick<Message, "content" | "parts">,
) => message.content ?? (extractMessageText(message.parts) || undefined);

export const getMessageSearchMigration = (ctx: Pick<QueryCtx, "db">) =>
  ctx.db
    .query("message_search_migration")
    .withIndex("by_name", (q) => q.eq("name", "search_text"))
    .unique();

export const usesSeparateMessageSearch = (
  state: Doc<"message_search_migration"> | null,
) =>
  state !== null && ["stripping", "ready", "restoring"].includes(state.phase);

export async function messageCopyText(
  ctx: Pick<QueryCtx, "db">,
  message: Message,
  migration?: Doc<"message_search_migration"> | null,
) {
  const state =
    migration === undefined ? await getMessageSearchMigration(ctx) : migration;
  if (!usesSeparateMessageSearch(state)) return message.content;
  const search = await ctx.db
    .query("message_search")
    .withIndex("by_message_id", (q) => q.eq("message_id", message._id))
    .unique();
  if (!search) throw new Error("Message search document missing");
  return search.content;
}

// Bulk copies normally need a whole chat. Read its small search rows together,
// then fall back to exact IDs if a bounded page misses rows (for example when
// migration insertion order differs from message order).
export async function messageCopyTexts(
  ctx: Pick<QueryCtx, "db">,
  messages: Message[],
  state: Doc<"message_search_migration"> | null,
) {
  if (!usesSeparateMessageSearch(state) || messages.length === 0)
    return messages.map((message) => message.content);
  const chatId = messages[0].chat_id;
  if (messages.some((message) => message.chat_id !== chatId))
    throw new Error("Bulk message copy must use one chat");
  const page = await ctx.db
    .query("message_search")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chatId))
    .paginate({
      cursor: null,
      numItems: Math.min(messages.length, 1000),
      maximumRowsRead: 1000,
      maximumBytesRead: 4 * 1024 * 1024,
    });
  const rows = new Map(page.page.map((row) => [row.message_id, row]));
  return Promise.all(
    messages.map((message) => {
      const row = rows.get(message._id);
      return row ? row.content : messageCopyText(ctx, message, state);
    }),
  );
}

export async function syncMessageSearch(
  ctx: MutationCtx,
  message: Message,
  existingRow?: Doc<"message_search"> | null,
) {
  const existing =
    existingRow === undefined
      ? await ctx.db
          .query("message_search")
          .withIndex("by_message_id", (q) => q.eq("message_id", message._id))
          .unique()
      : existingRow;
  const value = {
    message_id: message._id,
    id: message.id,
    chat_id: message.chat_id,
    user_id: message.user_id,
    content: message.content,
    is_hidden: message.is_hidden,
    created_at: existing
      ? (existing.created_at ?? existing._creationTime)
      : message._creationTime,
    update_time: message.update_time,
  };
  if (!existing) await ctx.db.insert("message_search", value);
  else if (
    Object.entries(value).some(
      ([key, value]) => existing[key as keyof typeof existing] !== value,
    )
  )
    await ctx.db.patch(existing._id, value);
}

export async function insertMessageWithSearch(
  ctx: MutationCtx,
  document: WithoutSystemFields<Message>,
  migration?: Doc<"message_search_migration"> | null,
) {
  const state =
    migration === undefined ? await getMessageSearchMigration(ctx) : migration;
  const strip =
    usesSeparateMessageSearch(state) && state?.phase !== "restoring";
  const id = await ctx.db.insert("messages", {
    ...document,
    content: strip ? undefined : document.content,
  });
  if (state) {
    // Search and body are inserted in the same transaction. The search row's
    // creation time preserves insertion order without reading the large body
    // back just to obtain its system timestamp. Backfills retain the original
    // message timestamp explicitly in created_at.
    await ctx.db.insert("message_search", {
      message_id: id,
      id: document.id,
      chat_id: document.chat_id,
      user_id: document.user_id,
      content: document.content,
      is_hidden: document.is_hidden,
      update_time: document.update_time,
    });
  }
  return id;
}

export async function patchMessageWithSearch(
  ctx: MutationCtx,
  message: Message,
  patch: Partial<WithoutSystemFields<Message>>,
) {
  const state = await getMessageSearchMigration(ctx);
  const strip =
    usesSeparateMessageSearch(state) && state?.phase !== "restoring";
  if (state) {
    const search = await ctx.db
      .query("message_search")
      .withIndex("by_message_id", (q) => q.eq("message_id", message._id))
      .unique();
    if (!("content" in patch) && usesSeparateMessageSearch(state)) {
      if (!search) throw new Error("Message search document missing");
      message = { ...message, content: search.content };
    }
    const updated = { ...message, ...patch };
    // Separation must not admit an edit/metadata update that the legacy
    // document cannot represent. Otherwise a valid write can wedge rollback.
    if (getDocumentSize(updated) > 1024 * 1024)
      throw new ConvexError({
        code: "MESSAGE_TOO_LARGE",
        message: "Message is too large to save",
      });
    await syncMessageSearch(ctx, updated, search);
  }
  await ctx.db.patch(message._id, {
    ...patch,
    ...(strip ? { content: undefined } : {}),
  });
}

export async function deleteMessageWithSearch(
  ctx: MutationCtx,
  message: Message,
) {
  const search = await ctx.db
    .query("message_search")
    .withIndex("by_message_id", (q) => q.eq("message_id", message._id))
    .unique();
  if (search) await ctx.db.delete(search._id);
  await ctx.db.delete(message._id);
}
