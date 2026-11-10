"use node";

import { v } from "convex/values";
import { internalAction } from "./lib/serviceFunctions";
import { internal } from "./_generated/api";
import { sendAbuseNotification } from "../lib/abuse/notification-mail";

export const deliver = internalAction({
  args: { notificationId: v.id("abuse_notifications") },
  returns: v.null(),
  handler: async (ctx, { notificationId }) => {
    const claim = await ctx.runMutation(internal.abuseNotifications.claim, {
      notificationId,
    });
    if (!claim) return null;
    const outcome = await sendAbuseNotification(claim.reference);
    await ctx.runMutation(internal.abuseNotifications.finish, {
      notificationId,
      attempt: claim.attempt,
      outcome,
    });
    return null;
  },
});
