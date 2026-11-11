import { v } from "convex/values";
import { mutation } from "./lib/serviceFunctions";
import { validateServiceKey } from "./lib/utils";
import { internal } from "./_generated/api";
import { abuseEvidenceKeyring } from "../lib/abuse/keyring";
import {
  ABUSE_PAYLOAD_RETENTION_MS,
  ABUSE_RECEIPT_RETENTION_MS,
} from "./lib/abuseQueue";

function boundedCiphertext(value: string) {
  if (
    !/^v1\.[a-zA-Z0-9_-]{1,32}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(
      value,
    ) ||
    value.length > 128 * 1024
  ) {
    throw new Error("Invalid encrypted evidence");
  }
}

export const receive = mutation({
  args: {
    serviceKey: v.string(),
    reference: v.string(),
    digests: v.array(v.string()),
    kind: v.union(v.literal("abuse"), v.literal("appeal")),
    ciphertext: v.string(),
    sourceHashes: v.array(v.string()),
    emailHashes: v.array(v.string()),
  },
  returns: v.object({
    outcome: v.union(
      v.literal("received"),
      v.literal("rate_limited"),
      v.literal("conflict"),
      v.literal("expired"),
    ),
    reference: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (process.env.ABUSE_INTAKE_ENABLED !== "true")
      throw new Error("Abuse intake unavailable");
    if (
      !/^AB-[a-f0-9-]{36}$/.test(args.reference) ||
      ![args.digests, args.sourceHashes, args.emailHashes].every(
        (values) =>
          values.length >= 1 &&
          values.length <= 5 &&
          values.every((value) => /^[a-f0-9]{64}$/.test(value)),
      )
    )
      throw new Error("Invalid intake metadata");
    boundedCiphertext(args.ciphertext);
    const queued = await ctx.db
      .query("abuse_notifications")
      .withIndex("by_reference", (q) => q.eq("reference", args.reference))
      .unique();
    if (queued) {
      if (!queued.digest || !args.digests.includes(queued.digest))
        return { outcome: "conflict" as const };
      if (
        queued.status === "expired" ||
        (queued.status !== "sent" &&
          (!queued.ciphertext ||
            queued.payloadExpiresAt === undefined ||
            queued.payloadExpiresAt <= Date.now()))
      )
        return { outcome: "expired" as const };
      return { outcome: "received" as const, reference: args.reference };
    }
    // Preserve receipt idempotency for reports accepted by the old case intake.
    const existing = await ctx.db
      .query("abuse_cases")
      .withIndex("by_reference", (q) => q.eq("reference", args.reference))
      .unique();
    if (existing)
      return args.digests.includes(existing.digest)
        ? { outcome: "received" as const, reference: existing.reference }
        : { outcome: "conflict" as const };
    if (!process.env.ABUSE_SMTP_PASSWORD)
      throw new Error("Abuse email delivery unavailable");
    const keyring = abuseEvidenceKeyring();
    if (!keyring.keys[args.ciphertext.split(".")[1]])
      throw new Error("Abuse delivery key unavailable");
    const now = Date.now();
    const hour = Math.floor(now / 3_600_000);
    const buckets = [
      ...args.sourceHashes.map(
        (hash) => [`source:${hash}:${hour}`, 5] as const,
      ),
      ...args.emailHashes.map((hash) => [`email:${hash}:${hour}`, 3] as const),
    ] as const;
    const limits = await Promise.all(
      buckets.map(async ([bucket, maximum]) => ({
        bucket,
        maximum,
        row: await ctx.db
          .query("abuse_rate_limits")
          .withIndex("by_bucket", (q) => q.eq("bucket", bucket))
          .unique(),
      })),
    );
    if (limits.some(({ row, maximum }) => row && row.count >= maximum))
      return { outcome: "rate_limited" as const };
    for (const { bucket, row } of limits) {
      if (row) await ctx.db.patch(row._id, { count: row.count + 1 });
      else
        await ctx.db.insert("abuse_rate_limits", {
          bucket,
          count: 1,
          expiresAt: (hour + 2) * 3_600_000,
        });
    }
    const notificationId = await ctx.db.insert("abuse_notifications", {
      reference: args.reference,
      digest: args.digests[0],
      ciphertext: args.ciphertext,
      receivedAt: now,
      payloadExpiresAt: now + ABUSE_PAYLOAD_RETENTION_MS,
      expiresAt: now + ABUSE_RECEIPT_RETENTION_MS,
      status: "pending",
      attempts: 0,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.abuseNotificationActions.deliver, {
      notificationId,
    });
    return { outcome: "received" as const, reference: args.reference };
  },
});
