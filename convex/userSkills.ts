import { isUserDeletionFenced } from "./lib/userDeletionFence";
import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";
import { validateServiceKey } from "./lib/utils";
import {
  MAX_USER_SKILLS,
  MAX_SELECTED_SKILLS,
  validateSkill,
} from "../lib/user-skills/contracts";

const metadata = v.object({
  id: v.id("user_skills"),
  name: v.string(),
  description: v.string(),
  isDefault: v.boolean(),
});
const fields = {
  name: v.string(),
  description: v.string(),
  content: v.string(),
};
const docMetadata = (s: {
  _id: Id<"user_skills">;
  name: string;
  description: string;
  is_default: boolean;
}) => ({
  id: s._id,
  name: s.name,
  description: s.description,
  isDefault: s.is_default,
});
async function owner(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Not authenticated");
  if (await isUserDeletionFenced(ctx.db, identity.subject))
    throw new ConvexError("Account deletion is in progress");
  await assertUserCanAccessChatHistory(ctx, identity.subject);
  return identity.subject;
}
async function ownedSkill(
  ctx: QueryCtx,
  id: Id<"user_skills">,
  userId: string,
) {
  const skill = await ctx.db.get(id);
  if (!skill || skill.user_id !== userId)
    throw new ConvexError("Skill not found");
  return skill;
}
async function ownedChat(ctx: QueryCtx, chatId: string, userId: string) {
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", chatId))
    .unique();
  if (
    !chat ||
    chat.user_id !== userId ||
    chat.deletion_started_at !== undefined
  )
    throw new ConvexError("Chat not found");
  return chat;
}
export async function defaultSkillIds(ctx: QueryCtx, userId: string) {
  return (
    await ctx.db
      .query("user_skills")
      .withIndex("by_user_default", (q) =>
        q.eq("user_id", userId).eq("is_default", true),
      )
      .take(MAX_SELECTED_SKILLS)
  ).map((s) => s._id);
}
export async function snapshotSkillSelection(
  ctx: MutationCtx,
  userId: string,
  chatId: string,
) {
  const draft = await ctx.db
    .query("user_skill_drafts")
    .withIndex("by_user_chat", (q) =>
      q.eq("user_id", userId).eq("chat_id", chatId),
    )
    .unique();
  if (!draft) return defaultSkillIds(ctx, userId);
  await ctx.db.delete(draft._id);
  return (await selectedMetadata(ctx, draft.ids, userId)).map((s) => s.id);
}
async function selectedMetadata(
  ctx: QueryCtx,
  ids: Id<"user_skills">[],
  userId: string,
) {
  const skills = await Promise.all(
    ids.slice(0, MAX_SELECTED_SKILLS).map((id) => ctx.db.get(id)),
  );
  return skills
    .filter(
      (s): s is NonNullable<typeof s> => s !== null && s.user_id === userId,
    )
    .map(docMetadata);
}
export const list = query({
  args: {},
  returns: v.array(metadata),
  handler: async (ctx) => {
    const userId = await owner(ctx);
    return (
      await ctx.db
        .query("user_skills")
        .withIndex("by_user", (q) => q.eq("user_id", userId))
        .take(MAX_USER_SKILLS)
    ).map(docMetadata);
  },
});
export const get = query({
  args: { id: v.id("user_skills") },
  returns: v.object(fields),
  handler: async (ctx, { id }) => {
    const s = await ownedSkill(ctx, id, await owner(ctx));
    return { name: s.name, description: s.description, content: s.content };
  },
});
export const save = mutation({
  args: { id: v.optional(v.id("user_skills")), ...fields },
  returns: v.id("user_skills"),
  handler: async (ctx, args) => {
    const userId = await owner(ctx);
    const draft = validateSkill(args);
    if (args.id) {
      await ownedSkill(ctx, args.id, userId);
      await ctx.db.patch(args.id, { ...draft, updated_at: Date.now() });
      return args.id;
    }
    const existing = await ctx.db
      .query("user_skills")
      .withIndex("by_user", (q) => q.eq("user_id", userId))
      .take(MAX_USER_SKILLS);
    if (existing.length >= MAX_USER_SKILLS)
      throw new ConvexError("You can save up to 32 skills.");
    return ctx.db.insert("user_skills", {
      ...draft,
      user_id: userId,
      is_default: false,
      updated_at: Date.now(),
    });
  },
});
export const remove = mutation({
  args: { id: v.id("user_skills") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await ownedSkill(ctx, id, await owner(ctx));
    await ctx.db.delete(id);
    return null; // Stale chat references are filtered on every read/load.
  },
});
export const setDefault = mutation({
  args: { id: v.id("user_skills"), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await owner(ctx);
    const skill = await ownedSkill(ctx, args.id, userId);
    if (
      args.enabled &&
      !skill.is_default &&
      (await defaultSkillIds(ctx, userId)).length >= MAX_SELECTED_SKILLS
    )
      throw new ConvexError("Choose up to 3 defaults.");
    await ctx.db.patch(args.id, { is_default: args.enabled });
    return null;
  },
});
export const selection = query({
  args: { chatId: v.string() },
  returns: v.array(metadata),
  handler: async (ctx, { chatId }) => {
    const userId = await owner(ctx);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", chatId))
      .unique();
    if (chat) {
      if (chat.user_id !== userId || chat.deletion_started_at !== undefined)
        throw new ConvexError("Chat not found");
      return selectedMetadata(ctx, chat.user_skill_ids ?? [], userId);
    }
    const draft = await ctx.db
      .query("user_skill_drafts")
      .withIndex("by_user_chat", (q) =>
        q.eq("user_id", userId).eq("chat_id", chatId),
      )
      .unique();
    return selectedMetadata(
      ctx,
      draft?.ids ?? (await defaultSkillIds(ctx, userId)),
      userId,
    );
  },
});
export const select = mutation({
  args: { chatId: v.string(), ids: v.array(v.id("user_skills")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await owner(ctx);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(args.chatId))
      throw new ConvexError("Invalid chat id");
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .unique();
    if (
      chat &&
      (chat.user_id !== userId || chat.deletion_started_at !== undefined)
    )
      throw new ConvexError("Chat not found");
    if (chat && (chat.active_stream_id || chat.active_trigger_run_id))
      throw new ConvexError(
        "Wait for the current response to finish before changing skills.",
      );
    if (
      args.ids.length > MAX_SELECTED_SKILLS ||
      new Set(args.ids).size !== args.ids.length
    )
      throw new ConvexError("Choose up to 3 different skills.");
    await Promise.all(args.ids.map((id) => ownedSkill(ctx, id, userId)));
    if (chat) await ctx.db.patch(chat._id, { user_skill_ids: args.ids });
    else {
      const draft = await ctx.db
        .query("user_skill_drafts")
        .withIndex("by_user_chat", (q) =>
          q.eq("user_id", userId).eq("chat_id", args.chatId),
        )
        .unique();
      if (draft)
        await ctx.db.patch(draft._id, {
          ids: args.ids,
          updated_at: Date.now(),
        });
      else {
        const drafts = await ctx.db
          .query("user_skill_drafts")
          .withIndex("by_user", (q) => q.eq("user_id", userId))
          .take(32);
        if (drafts.length >= 32) {
          const oldest = drafts.reduce((a, b) =>
            a.updated_at <= b.updated_at ? a : b,
          );
          await ctx.db.delete(oldest._id);
        }
        await ctx.db.insert("user_skill_drafts", {
          user_id: userId,
          chat_id: args.chatId,
          ids: args.ids,
          updated_at: Date.now(),
        });
      }
    }
    return null;
  },
});
export const runtimeSelection = query({
  args: { serviceKey: v.string(), userId: v.string(), chatId: v.string() },
  returns: v.array(metadata),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (await isUserDeletionFenced(ctx.db, args.userId))
      throw new ConvexError("Account deletion is in progress");
    await assertUserCanAccessChatHistory(ctx, args.userId);
    const chat = await ownedChat(ctx, args.chatId, args.userId);
    return selectedMetadata(ctx, chat.user_skill_ids ?? [], args.userId);
  },
});
export const runtimeLoad = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    id: v.id("user_skills"),
  },
  returns: v.object(fields),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (await isUserDeletionFenced(ctx.db, args.userId))
      throw new ConvexError("Account deletion is in progress");
    await assertUserCanAccessChatHistory(ctx, args.userId);
    const chat = await ownedChat(ctx, args.chatId, args.userId);
    if (!chat.user_skill_ids?.includes(args.id))
      throw new ConvexError("Skill is not selected for this chat");
    const s = await ownedSkill(ctx, args.id, args.userId);
    return { name: s.name, description: s.description, content: s.content };
  },
});
