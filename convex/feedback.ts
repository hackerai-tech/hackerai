import { mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";

export const createFeedback = mutation({
  args: {
    feedback_type: v.union(v.literal("positive"), v.literal("negative")),
    feedback_details: v.optional(v.string()),
    message_id: v.string(),
  },
  returns: v.id("feedback"),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    // Find the message to update
    const message = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("id", args.message_id))
      .unique();

    if (!message) {
      throw new ConvexError({
        code: "MESSAGE_NOT_FOUND",
        message: "Message not found",
      });
    } else if (message.user_id !== user.subject) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message:
          "Unauthorized: User not allowed to give feedback for this message",
      });
    }

    // If message already has feedback, update it
    if (message.feedback_id) {
      await ctx.db.patch(message.feedback_id, {
        feedback_type: args.feedback_type,
        feedback_details: args.feedback_details,
      });
      return message.feedback_id;
    } else {
      // Create new feedback
      const feedbackId = await ctx.db.insert("feedback", {
        feedback_type: args.feedback_type,
        feedback_details: args.feedback_details,
      });

      // Update the message with the feedback_id
      await ctx.db.patch(message._id, {
        feedback_id: feedbackId,
      });

      return feedbackId;
    }
  },
});
