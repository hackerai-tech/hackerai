import { v } from "convex/values";
import { internalAction } from "./lib/serviceFunctions";
import { internal } from "./_generated/api";
import { readTwoCaptchaExpense } from "../lib/ai/captcha/provider-expense";

/** Independent of the Agent lifetime. Never deliver a token, create a paid task
 * or replay a customer usage deduction from reconciliation.
 */
export const reconcile = internalAction({
  args: { id: v.id("captcha_attempts") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const next = await ctx.runMutation(
      internal.captchaAttempts.beginReconciliation,
      { id },
    );
    const key = process.env.TWOCAPTCHA_API_KEY;
    if (!next?.taskId || !key) return null;
    const expense = await readTwoCaptchaExpense(key, next.taskId);
    if (expense.status === "ready" || expense.status === "unsolvable")
      await ctx.runMutation(internal.captchaAttempts.settleReconciliation, {
        id,
        taskId: next.taskId,
        ...(expense.status === "ready"
          ? { costDollars: expense.costDollars }
          : {}),
        unsolvable: expense.status === "unsolvable",
      });
    return null;
  },
});
