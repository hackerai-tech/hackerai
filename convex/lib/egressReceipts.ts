import type { Infer } from "convex/values";
import type { MutationCtx } from "./serviceFunctions";
import { egressReviewReceiptFields } from "./abuseValidators";
import { v } from "convex/values";

const receiptValidator = v.object(egressReviewReceiptFields);
export type ReceiptFields = Omit<
  Infer<typeof receiptValidator>,
  "createdAt" | "expiresAt"
>;

/** Aggregate monitoring only; long enough for weekly owner summaries. */
export const RECEIPT_TTL_MS = 30 * 24 * 60 * 60_000;
const PURGE_BATCH = 20;

/**
 * One receipt per review case window. The first decision wins, like the case
 * it describes; expired receipts are purged in small batches on each write.
 */
export async function insertReceipt(
  ctx: MutationCtx,
  fields: ReceiptFields,
  now = Date.now(),
): Promise<"created" | "existing"> {
  const expired = await ctx.db
    .query("egress_review_receipts")
    .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
    .take(PURGE_BATCH);
  for (const row of expired) await ctx.db.delete(row._id);
  const existing = await ctx.db
    .query("egress_review_receipts")
    .withIndex("by_digest", (q) => q.eq("digest", fields.digest))
    .first();
  if (existing) return "existing";
  await ctx.db.insert("egress_review_receipts", {
    ...fields,
    createdAt: now,
    expiresAt: now + RECEIPT_TTL_MS,
  });
  return "created";
}
