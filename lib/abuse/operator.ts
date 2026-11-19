import { z } from "zod";

export const abuseStatuses = [
  "new",
  "reviewing",
  "containing",
  "contained",
  "needs_followup",
  "resolved",
] as const;
const reference = z.string().regex(/^AB-[a-f0-9-]{36}$/);
const revised = { reference, expectedRevision: z.number().int().nonnegative() };
const decision = z.string().trim().min(20).max(6000);
export const abuseOperatorRequest = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      status: z.enum(abuseStatuses),
      cursor: z.string().max(3000).nullable().default(null),
    })
    .strict(),
  z
    .object({
      action: z.literal("read"),
      reference,
      cursor: z.string().max(3000).nullable().default(null),
    })
    .strict(),
  z
    .object({
      action: z.literal("annotate"),
      ...revised,
      kind: z.enum(["allegation", "verified_fact", "decision"]),
      decision,
    })
    .strict(),
  z
    .object({
      action: z.literal("contain"),
      ...revised,
      userId: z.string().min(1).max(160),
      chatId: z.string().min(1).max(160),
      runId: z.string().regex(/^run_[a-zA-Z0-9]+$/),
      sandboxId: z.string().max(160).optional(),
      region: z.enum(["us-east-1", "us-west-2", "eu-central-1"]).optional(),
      acknowledgeImpact: z.literal(true),
      preserveSnapshot: z.boolean().default(false),
      decision,
    })
    .strict(),
  z.object({ action: z.literal("retry"), ...revised }).strict(),
  z
    .object({
      action: z.literal("stop_without_snapshot"),
      ...revised,
      decision,
      acknowledgeEvidenceLoss: z.literal(true),
    })
    .strict(),
  z
    .object({ action: z.literal("confirm_local_stop"), ...revised, decision })
    .strict(),
  z.object({ action: z.literal("resolve"), ...revised, decision }).strict(),
  z.object({ action: z.literal("reconcile_snapshot"), ...revised }).strict(),
  z
    .object({
      action: z.literal("hold"),
      ...revised,
      hold: z.boolean(),
      decision,
    })
    .strict(),
  z
    .object({ action: z.literal("erase"), ...revised, confirmation: reference })
    .strict(),
]);
export function isAbuseOperator(userId: string | undefined | null): boolean {
  return Boolean(
    userId &&
    (process.env.ABUSE_OPERATOR_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .includes(userId),
  );
}
