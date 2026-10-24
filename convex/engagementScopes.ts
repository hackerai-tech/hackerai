import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  type QueryCtx,
  type MutationCtx,
} from "./lib/serviceFunctions";
import { validateServiceKey } from "./lib/utils";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";
import { scopePolicy } from "./engagementScopeValidators";

// Compatibility only: previously deployed apps/workers may still call these
// endpoints during rollout. Never read, extract, apply, or write scope again.
// Keep the old argument contracts so in-flight workers can finish normally.
const backendArgs = {
  serviceKey: v.string(),
  chatId: v.string(),
  userId: v.string(),
};
async function assertOwnedChat(
  ctx: QueryCtx | MutationCtx,
  chatId: string,
  userId: string,
) {
  await assertUserCanAccessChatHistory(ctx, userId);
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", chatId))
    .unique();
  if (!chat || chat.user_id !== userId || chat.deletion_started_at)
    throw new ConvexError("Chat unavailable");
}
async function assertBackend(
  ctx: QueryCtx | MutationCtx,
  args: { serviceKey: string; chatId: string; userId: string },
) {
  validateServiceKey(args.serviceKey);
  await assertOwnedChat(ctx, args.chatId, args.userId);
}
async function assertViewer(ctx: QueryCtx | MutationCtx, chatId: string) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Unauthenticated");
  await assertOwnedChat(ctx, chatId, identity.subject);
}
export const get = query({
  args: { chatId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertViewer(ctx, args.chatId);
    return null;
  },
});
export const getForBackend = query({
  args: backendArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertBackend(ctx, args);
    return null;
  },
});
export const getRetrySource = query({
  args: backendArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertBackend(ctx, args);
    return null;
  },
});
export const beginUserMessage = mutation({
  args: { ...backendArgs, messageId: v.string() },
  returns: v.object({
    complete: v.boolean(),
    revision: v.number(),
    sourceText: v.string(),
    current: v.null(),
  }),
  handler: async (ctx, args) => {
    await assertBackend(ctx, args);
    return { complete: true, revision: 0, sourceText: "", current: null };
  },
});
export const commitUserMessage = mutation({
  args: {
    ...backendArgs,
    messageId: v.string(),
    expectedRevision: v.number(),
    policy: scopePolicy,
    clarification: v.string(),
    unavailable: v.boolean(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertBackend(ctx, args);
    return false;
  },
});
export const claimClarification = mutation({
  args: { ...backendArgs, revision: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertBackend(ctx, args);
    return false;
  },
});
export const edit = mutation({
  args: {
    chatId: v.string(),
    expectedRevision: v.number(),
    policy: scopePolicy,
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await assertViewer(ctx, args.chatId);
    throw new ConvexError(
      "Engagement scope has been retired. Reload this page.",
    );
  },
});
