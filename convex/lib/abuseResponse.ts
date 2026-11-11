import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./serviceFunctions";
import { validateServiceKey } from "./utils";
import { abuseEvidenceKeyring } from "../../lib/abuse/keyring";

// The CLI renews this lease on every recorded step; an interrupted operator
// process can be retried after it expires without overlapping a live one.
export const ABUSE_RESPONSE_LEASE_MS = 5 * 60_000;
export const ABUSE_RESPONSE_MAX_TARGETS = 100;
export const ABUSE_RESPONSE_PAGE_SIZE = 25;
const CONNECTION_BATCH = 100;
const ENVIRONMENT_LOOKUP_LIMIT = 200;

export type AbuseResponseErrorCode =
  | "ABUSE_CASE_UNAVAILABLE"
  | "ABUSE_INVALID_INPUT"
  | "ABUSE_REVIEW_REQUIRED"
  | "ABUSE_SCOPE_MISMATCH"
  | "ABUSE_ENVIRONMENT_UNVERIFIED"
  | "ABUSE_COMPETING_CASE"
  | "ABUSE_RESTRICTION_CONFLICT"
  | "ABUSE_PLAN_CHANGED"
  | "ABUSE_RESPONSE_EXISTS"
  | "ABUSE_RESPONSE_BUSY"
  | "ABUSE_RESPONSE_LEASE_LOST"
  | "ABUSE_IMPORT_CONFLICT";

/** Codes only: application messages can echo identifiers into native logs. */
export function abuseResponseError(code: AbuseResponseErrorCode) {
  return new ConvexError({ code });
}

export function isAbuseOperatorId(id: string): boolean {
  return (process.env.ABUSE_OPERATOR_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(id);
}

export function assertAbuseOperator(serviceKey: string, actor: string) {
  validateServiceKey(serviceKey);
  if (!isAbuseOperatorId(actor))
    throw new Error("Abuse operator access denied");
}

/** Optionally require a key this deployment can decrypt, so notes stay readable. */
export function boundedAbuseCiphertext(value: string, requireKnownKey = false) {
  if (
    !/^v1\.[a-zA-Z0-9_-]{1,32}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(
      value,
    ) ||
    value.length > 128 * 1024 ||
    (requireKnownKey && !abuseEvidenceKeyring().keys[value.split(".")[1]])
  ) {
    throw new Error("Invalid encrypted evidence");
  }
}

export const lateRestrictionSource = (reference: string) =>
  `abuse-late:${reference}`;

export type AbuseResponseScope = {
  userId: string;
  chatId: string;
  runId?: string;
  transport: "cloud" | "local" | "desktop";
  environmentId?: string;
};

function validScope(scope: AbuseResponseScope) {
  return (
    scope.userId.length > 0 &&
    scope.userId.length <= 160 &&
    scope.chatId.length > 0 &&
    scope.chatId.length <= 160 &&
    (scope.runId === undefined || /^run_[a-zA-Z0-9]+$/.test(scope.runId)) &&
    (scope.environmentId === undefined ||
      (scope.transport !== "cloud" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          scope.environmentId,
        )))
  );
}

async function sha256(text: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Verify the stored account/chat/environment identity and fingerprint the
 * exact plan. Report text never selects the account; the operator supplies
 * verified identifiers and the server checks them against recorded ownership.
 */
export async function computeResponsePlan(
  ctx: QueryCtx | MutationCtx,
  row: Doc<"abuse_cases">,
  scope: AbuseResponseScope,
) {
  if (
    row.kind !== "abuse" ||
    !row.ciphertext ||
    row.containment ||
    !["new", "reviewing", "needs_followup"].includes(row.status)
  )
    throw abuseResponseError("ABUSE_CASE_UNAVAILABLE");
  if (!validScope(scope)) throw abuseResponseError("ABUSE_INVALID_INPUT");
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", scope.chatId))
    .unique();
  if (!chat || chat.user_id !== scope.userId)
    throw abuseResponseError("ABUSE_SCOPE_MISMATCH");
  if (scope.environmentId) {
    const connections = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_user_id", (q) => q.eq("user_id", scope.userId))
      .order("desc")
      .take(ENVIRONMENT_LOOKUP_LIMIT);
    if (
      !connections.some(
        (connection) =>
          connection.environment_id === scope.environmentId &&
          (connection.client_version === "desktop") ===
            (scope.transport === "desktop"),
      )
    )
      throw abuseResponseError("ABUSE_ENVIRONMENT_UNVERIFIED");
  }
  const competing = await ctx.db
    .query("abuse_cases")
    .withIndex("by_active_containment_user", (q) =>
      q.eq("activeContainmentUserId", scope.userId),
    )
    .first();
  if (competing && competing._id !== row._id)
    throw abuseResponseError("ABUSE_COMPETING_CASE");
  const sourceId = lateRestrictionSource(row.reference);
  // A manually applied case restriction is adopted, never duplicated.
  const existing = await ctx.db
    .query("user_suspensions")
    .withIndex("by_user_and_source", (q) =>
      q.eq("user_id", scope.userId).eq("source_id", sourceId),
    )
    .unique();
  if (
    existing &&
    (existing.category !== "security_abuse" ||
      existing.source !== "support" ||
      existing.status !== "active")
  )
    throw abuseResponseError("ABUSE_RESTRICTION_CONFLICT");
  const digest = await sha256(
    JSON.stringify([
      "abuse-response-plan-v1",
      row.reference,
      row.revision,
      row.status,
      scope.userId,
      scope.chatId,
      scope.runId ?? null,
      scope.transport,
      scope.environmentId ?? null,
      sourceId,
      existing?._id ?? null,
    ]),
  );
  return { sourceId, existing, digest };
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value
    ? time
    : undefined;
}

/** Review dates are records, not a retention guarantee. */
export function assertReviewDates(
  reviewDate: string,
  retentionReviewDate: string,
  now: number,
) {
  const review = validDate(reviewDate);
  const retention = validDate(retentionReviewDate);
  if (
    review === undefined ||
    retention === undefined ||
    review > now ||
    retention <= review
  )
    throw abuseResponseError("ABUSE_INVALID_INPUT");
}

/**
 * Revoke local access in the restriction's transaction. The token is replaced
 * by an unreturned value, so no plaintext token is read back or returned.
 * Connection invalidation is bounded; any remainder is retried.
 */
export async function invalidateLocalAccess(
  ctx: MutationCtx,
  userId: string,
  sourceId: string,
  now: number,
) {
  const tokens = await ctx.db
    .query("local_sandbox_tokens")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .take(5);
  let token: "revoked" | "already_revoked" | "none_issued" = tokens.length
    ? "already_revoked"
    : "none_issued";
  for (const row of tokens) {
    if (row.revoked_at !== undefined) continue;
    token = "revoked";
    await ctx.db.patch(row._id, {
      token: `revoked_${crypto.randomUUID()}`,
      revoked_at: now,
      revoked_source_id: sourceId,
      updated_at: now,
    });
  }
  if (!tokens.length)
    await ctx.db.insert("local_sandbox_tokens", {
      user_id: userId,
      token: `revoked_${crypto.randomUUID()}`,
      token_created_at: now,
      updated_at: now,
      revoked_at: now,
      revoked_source_id: sourceId,
    });
  const connected = await ctx.db
    .query("local_sandbox_connections")
    .withIndex("by_user_and_status", (q) =>
      q.eq("user_id", userId).eq("status", "connected"),
    )
    .take(CONNECTION_BATCH + 1);
  for (const connection of connected.slice(0, CONNECTION_BATCH)) {
    // Existing clients already stop on this reason; the case records the cause.
    await ctx.db.patch(connection._id, {
      status: "disconnected",
      disconnected_at: now,
      disconnect_reason: "token_regenerated",
    });
  }
  return {
    token,
    disconnected: Math.min(connected.length, CONNECTION_BATCH),
    remaining: connected.length > CONNECTION_BATCH,
  };
}

/**
 * Lift the local-access block only once no security restriction remains; any
 * case may have created the marker. The user must then issue a new token.
 */
export async function releaseLocalAccess(ctx: MutationCtx, userId: string) {
  const remaining = await ctx.db
    .query("user_suspensions")
    .withIndex("by_user_status_category_source_created", (q) =>
      q
        .eq("user_id", userId)
        .eq("status", "active")
        .eq("category", "security_abuse"),
    )
    .first();
  if (remaining) return;
  const tokens = await ctx.db
    .query("local_sandbox_tokens")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .take(5);
  for (const row of tokens) {
    if (row.revoked_at !== undefined) await ctx.db.delete(row._id);
  }
}

export async function summarizeResponse(
  ctx: QueryCtx | MutationCtx,
  row: Doc<"abuse_cases">,
  response: Doc<"abuse_responses">,
) {
  const suspension = await ctx.db.get(response.suspensionId);
  const restrictionStatus =
    suspension &&
    suspension.user_id === response.userId &&
    suspension.source_id === response.sourceId
      ? suspension.status
      : ("missing" as const);
  const inProgress = (response.operationExpiresAt ?? 0) > Date.now();
  const outstanding = ["process_stop_unconfirmed"];
  if (restrictionStatus !== "active")
    outstanding.push("restriction_not_active");
  if (response.connectionsRemaining)
    outstanding.push("local_connections_remaining");
  if (response.discoveryPhase !== "done")
    outstanding.push("discovery_incomplete");
  if (response.targetOverflow) outstanding.push("target_overflow");
  if (response.targets.some((target) => target.state !== "terminal"))
    outstanding.push("cancellation_unconfirmed");
  if (response.transport === "cloud")
    outstanding.push("cloud_provider_unverified");
  return {
    reference: row.reference,
    requestId: response.requestId,
    sourceId: response.sourceId,
    userId: response.userId,
    chatId: response.chatId,
    ...(response.runId ? { runId: response.runId } : {}),
    transport: response.transport,
    ...(response.environmentId
      ? { environmentId: response.environmentId }
      : {}),
    actor: response.actor,
    reviewer: response.reviewer,
    reviewDate: response.reviewDate,
    retentionReviewDate: response.retentionReviewDate,
    appliedAt: response.appliedAt,
    caseStatus: row.status,
    restriction: { result: response.restriction, status: restrictionStatus },
    localToken: response.localToken,
    localConnections: {
      disconnected: response.connectionsDisconnected,
      remaining: response.connectionsRemaining,
    },
    discovery: {
      phase: response.discoveryPhase,
      overflow: response.targetOverflow,
    },
    cancellations: response.targets.map((target) => ({
      runId: target.runId,
      kind: target.kind,
      chatId: target.chatId,
      state: target.state,
      ...(target.triggerStatus ? { triggerStatus: target.triggerStatus } : {}),
      attempts: target.attempts,
    })),
    // This flow never destroys a provider workspace from a historical run.
    cloudProvider:
      response.transport === "cloud"
        ? ("not_attempted" as const)
        : ("not_applicable" as const),
    processStop: "unconfirmed" as const,
    contained: false as const,
    inProgress,
    outstanding,
  };
}
