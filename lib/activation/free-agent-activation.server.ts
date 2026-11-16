import type { UIMessage } from "ai";
import type { PostHog } from "posthog-node";
import { v5 as uuidv5 } from "uuid";
import PostHogClient from "@/app/posthog";
import { ChatSDKError } from "@/lib/errors";
import { hasCompletedAssistantText } from "@/lib/analytics/free-activation";
import { isSubscriptionFirstCountry } from "@/lib/experiments/regional-subscription-first";
import {
  ANALYTICS_CONSENT_COOKIE_NAME,
  countryCodeFromHeaders,
  getAnalyticsConsentDecision,
} from "@/lib/privacy/analytics-consent";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  FREE_AGENT_ACTIVATION_DEFINITION_VERSION,
  FREE_AGENT_ACTIVATION_KEY,
  FREE_AGENT_ACTIVATION_REQUIRED_METADATA,
  FREE_AGENT_ASK_INTRO_LIMIT,
  createFreeAgentActivationStatus,
  type FreeAgentActivationStatus,
  type FreeAgentActivationVariant,
} from "./free-agent-activation";

/** Versioned per free-quota-subject set of persisted Ask response IDs. */
export const FREE_AGENT_ACTIVATION_STORAGE_PREFIX = "free_agent_activation:v1:";
export const freeAgentActivationStorageKey = (quotaSubject: string) =>
  `${FREE_AGENT_ACTIVATION_STORAGE_PREFIX}${quotaSubject}`;

/** Growth-experiment lookups must never hold a request open for long. */
const REMOTE_TIMEOUT_MS = 750;
export const FREE_AGENT_ACTIVATION_ASSIGNED_EVENT =
  "free_agent_activation_assigned";
const MAX_USER_AGENT_LENGTH = 512;
const MAX_RESPONSE_ID_LENGTH = 128;

/**
 * Adds one response ID while fewer than the limit are stored. A repeated ID is
 * a no-op, so retried completion counts once and storage stays constant.
 * No TTL: introductions are lifetime, not daily.
 */
const RECORD_ASK_RESPONSE_SCRIPT = `
local key = KEYS[1]
local responseId = ARGV[1]
local limit = tonumber(ARGV[2])
if redis.call("SISMEMBER", key, responseId) == 1 then
  return redis.call("SCARD", key)
end
local count = redis.call("SCARD", key)
if count >= limit then
  return count
end
redis.call("SADD", key, responseId)
return count + 1
`;

/**
 * First assignment time per trusted user and definition version. Telemetry
 * only: it never affects access. Keyed by userId (not the shared quota
 * subject) so each account owns and deletes its own marker.
 */
export const FREE_AGENT_ACTIVATION_ASSIGNMENT_PREFIX =
  "free_agent_activation_assignment:";
export const freeAgentActivationAssignmentKey = (userId: string) =>
  `${FREE_AGENT_ACTIVATION_ASSIGNMENT_PREFIX}v${FREE_AGENT_ACTIVATION_DEFINITION_VERSION}:${userId}`;

/** Atomic get-or-set; returns the stored first-assignment epoch ms. */
const FIRST_ASSIGNMENT_SCRIPT = `
local existing = redis.call("GET", KEYS[1])
if existing then
  return existing
end
redis.call("SET", KEYS[1], ARGV[1])
return ARGV[1]
`;

export type FreeAgentActivationEnrollment = {
  variant: FreeAgentActivationVariant;
  quotaSubject: string;
};

/**
 * `null` is a known exclusion (ineligible, flag off or not configured);
 * `undefined` means the flag service could not answer.
 */
type FreeAgentActivationAssessment =
  FreeAgentActivationEnrollment | null | undefined;

/** Authenticated session fields; never request-body values. */
export type FreeAgentActivationIdentity = {
  userId: string;
  subscription: string;
  organizationId?: string;
  accountCreatedAt?: string;
  freeQuotaSubject?: string;
  freeUsageQuotaSubject?: string;
};

export type FreeAgentActivationRequest = {
  headers: Headers;
  cookies: { get(name: string): { value: string } | undefined };
};

type FlagClient = Pick<PostHog, "getFeatureFlagResult"> &
  Partial<Pick<PostHog, "capture" | "on">>;

const STRICT_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

/** Parse a strict ISO-8601 instant with an explicit zone; reject rollovers. */
export function parseStrictTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return;
  const match = STRICT_TIMESTAMP.exec(value);
  if (!match) return;
  const [, y, mo, d, h, mi, s, frac = "0", zone] = match;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(
    Number,
  );
  if (hour > 23 || minute > 59 || second > 59) return;
  const local = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    Number(frac.padEnd(3, "0")),
  );
  const date = new Date(local);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return;
  if (zone === "Z") return local;
  const offsetHours = Number(zone.slice(1, 3));
  const offsetMinutes = Number(zone.slice(4, 6));
  if (offsetHours > 23 || offsetMinutes > 59) return;
  const offsetMs = (offsetHours * 60 + offsetMinutes) * 60_000;
  return zone[0] === "+" ? local - offsetMs : local + offsetMs;
}

const NON_DESKTOP_USER_AGENT =
  /Mobi|Android|iPhone|iPad|iPod|Tablet|Silk|Kindle|PlayBook|BlackBerry|BB10|Opera Mini|IEMobile|webOS|CriOS|FxiOS|EdgiOS|OPiOS|HackerAI-Desktop|Electron|Tauri|HeadlessChrome|bot|crawler|spider/i;
const DESKTOP_OS = /Windows NT|Macintosh|X11|CrOS|Linux x86_64/;
// Chromium-family and Firefox only. iPadOS requests desktop sites with a
// user agent identical to macOS Safari, so Safari-only agents are excluded
// rather than risk gating Ask on a tablet.
const DESKTOP_BROWSER = /(?:Chrome|Chromium|Firefox|Edg)\/\d/;

/**
 * Desktop OS browser only: phones, tablets and the native app are excluded
 * when identifiable. Narrow desktop windows remain eligible because the
 * decision uses device class, not viewport width.
 */
export function isSupportedDesktopBrowserRequest(headers: Headers): boolean {
  if (headers.get("sec-ch-ua-mobile")?.trim() === "?1") return false;
  const userAgent = headers.get("user-agent");
  if (!userAgent || userAgent.length > MAX_USER_AGENT_LENGTH) return false;
  if (NON_DESKTOP_USER_AGENT.test(userAgent)) return false;
  return DESKTOP_OS.test(userAgent) && DESKTOP_BROWSER.test(userAgent);
}

/** Same trusted fallback as the existing free limits and run lock. */
function quotaSubjectFor(identity: FreeAgentActivationIdentity): string {
  return (
    identity.freeUsageQuotaSubject ??
    identity.freeQuotaSubject ??
    identity.userId
  );
}

function newUsersFromPayload(payload: unknown): number | undefined {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  return parseStrictTimestamp(
    (value as Record<string, unknown>).new_users_from,
  );
}

type EvaluationArgs = {
  request: FreeAgentActivationRequest;
  identity: FreeAgentActivationIdentity;
  posthog?: FlagClient | null;
};

/**
 * Server-owned enrollment shared by Ask admission and the status API.
 * Evaluation is assignment only; it never records exposure.
 */
async function assessFreeAgentActivation({
  request,
  identity,
  posthog = PostHogClient(),
}: EvaluationArgs): Promise<FreeAgentActivationAssessment> {
  if (
    !identity.userId ||
    identity.subscription !== "free" ||
    identity.organizationId
  )
    return null;
  const accountCreatedAtMs = parseStrictTimestamp(identity.accountCreatedAt);
  if (accountCreatedAtMs === undefined) return null;
  if (!isSupportedDesktopBrowserRequest(request.headers)) return null;
  const country = countryCodeFromHeaders(request.headers);
  // Exclude every subscription-first country so the experiments never overlap.
  if (isSubscriptionFirstCountry(country)) return null;
  const { analyticsAllowed } = getAnalyticsConsentDecision({
    cookieValue: request.cookies.get(ANALYTICS_CONSENT_COOKIE_NAME)?.value,
    countryCode: country,
    failClosed: true,
  });
  // No configured client means the experiment is off here, not unavailable.
  if (!analyticsAllowed || !posthog) return null;

  // posthog-node resolves `undefined` both for an absent/inactive flag and for
  // a failed /flags request; only the latter emits the client's error event.
  let flagRequestFailed = false;
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = posthog.on?.("error", () => {
      flagRequestFailed = true;
    });
  } catch {
    // Without failure events, an undefined result stays a known exclusion.
  }
  let variant: FreeAgentActivationVariant;
  try {
    const result = await withRemoteTimeout(
      posthog.getFeatureFlagResult(FREE_AGENT_ACTIVATION_KEY, identity.userId, {
        sendFeatureFlagEvents: false,
        personProperties: { subscription: "free" },
      }),
    );
    if (!result) return flagRequestFailed ? undefined : null;
    if (result.enabled !== true) return null;
    if (result.variant !== "control" && result.variant !== "test") return null;
    const newUsersFrom = newUsersFromPayload(result.payload);
    if (newUsersFrom === undefined || accountCreatedAtMs < newUsersFrom)
      return null;
    variant = result.variant;
  } catch {
    return undefined;
  } finally {
    try {
      unsubscribe?.();
    } catch {
      // Listener cleanup cannot change the evaluation.
    }
  }
  await captureAssignment(posthog, identity.userId, variant);
  return { variant, quotaSubject: quotaSubjectFor(identity) };
}

/**
 * Ask admission: every exclusion and every operational failure yields no
 * enrollment, so an unavailable experiment never changes access.
 */
export async function evaluateFreeAgentActivation(
  args: EvaluationArgs,
): Promise<FreeAgentActivationEnrollment | undefined> {
  return (await assessFreeAgentActivation(args)) ?? undefined;
}

/**
 * Status API: `null` is a known exclusion; `undefined` means the flag service
 * could not answer, which the caller reports as unavailable.
 */
export async function evaluateFreeAgentActivationForStatus(
  args: EvaluationArgs,
): Promise<FreeAgentActivationEnrollment | null | undefined> {
  return assessFreeAgentActivation(args);
}

async function readOrSetFirstAssignmentMs(
  userId: string,
): Promise<number | undefined> {
  const redis = createRedisClient();
  if (!redis) return;
  try {
    const stored = await withRemoteTimeout(
      redis.eval<string[], unknown>(
        FIRST_ASSIGNMENT_SCRIPT,
        [freeAgentActivationAssignmentKey(userId)],
        [String(Date.now())],
      ),
    );
    const firstAssignedAtMs = Number(stored);
    return Number.isSafeInteger(firstAssignedAtMs) && firstAssignedAtMs > 0
      ? firstAssignedAtMs
      : undefined;
  } catch (error) {
    logStorageFailure("assignment", error);
  }
}

/**
 * All-assigned denominator, independent of UI rendering. Not exposure: no
 * $feature_flag_called or $experiment_exposure. Every lookup re-sends this
 * event with one stable UUID and the stored first-assignment time per user
 * and definition version, so storage can eventually merge repeats. Raw event
 * counts are still not a participant count; readouts use unique assigned
 * users and their earliest assignment. Without the marker, nothing is sent.
 */
async function captureAssignment(
  posthog: FlagClient,
  userId: string,
  variant: FreeAgentActivationVariant,
) {
  if (!posthog.capture) return;
  try {
    const firstAssignedAtMs = await readOrSetFirstAssignmentMs(userId);
    if (firstAssignedAtMs === undefined) return;
    posthog.capture({
      distinctId: userId,
      event: FREE_AGENT_ACTIVATION_ASSIGNED_EVENT,
      uuid: uuidv5(
        `${FREE_AGENT_ACTIVATION_KEY}:v${FREE_AGENT_ACTIVATION_DEFINITION_VERSION}:assigned:${userId}`,
        uuidv5.URL,
      ),
      timestamp: new Date(firstAssignedAtMs),
      properties: {
        variant,
        definition_version: FREE_AGENT_ACTIVATION_DEFINITION_VERSION,
        [`$feature/${FREE_AGENT_ACTIVATION_KEY}`]: variant,
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
  } catch {
    // Telemetry failure must not change enrollment.
  }
}

function withRemoteTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("free_agent_activation_remote_timeout")),
        REMOTE_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function logStorageFailure(
  operation: "read" | "record" | "assignment",
  error: unknown,
) {
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "free_agent_activation_storage_unavailable",
      service: "free-agent-activation",
      operation,
      error_name: error instanceof Error ? error.name : typeof error,
      timeout:
        error instanceof Error &&
        error.message === "free_agent_activation_remote_timeout",
    }),
  );
}

/** Stored count, or undefined when storage is unavailable (not zero). */
export async function readCompletedAskResponses(
  quotaSubject: string,
): Promise<number | undefined> {
  const redis = createRedisClient();
  if (!redis) return;
  try {
    const count = Number(
      await withRemoteTimeout(
        redis.scard(freeAgentActivationStorageKey(quotaSubject)),
      ),
    );
    return Number.isFinite(count) ? count : undefined;
  } catch (error) {
    logStorageFailure("read", error);
  }
}

/**
 * Shared by the status API and Ask admission. `null` means not enrolled;
 * `undefined` means the stored count could not be read (unknown, not zero).
 */
export async function getFreeAgentActivationStatus(
  enrollment: FreeAgentActivationEnrollment | null | undefined,
): Promise<FreeAgentActivationStatus | null | undefined> {
  if (!enrollment) return null;
  const completed = await readCompletedAskResponses(enrollment.quotaSubject);
  if (completed === undefined) return undefined;
  return createFreeAgentActivationStatus(enrollment.variant, completed);
}

/**
 * Called under the free run lock, before quota consumption and provider
 * work. Storage outages fail open; every existing gate still applies.
 */
export async function enforceFreeAgentActivationAskAdmission(
  enrollment: FreeAgentActivationEnrollment | undefined,
): Promise<void> {
  if (enrollment?.variant !== "test") return;
  const status = await getFreeAgentActivationStatus(enrollment);
  if (!status?.requiresAgent) return;
  throw new ChatSDKError(
    "forbidden:chat",
    "Continue in Agent mode with your computer to keep going.",
    { [FREE_AGENT_ACTIVATION_REQUIRED_METADATA]: true },
  );
}

async function recordCompletedAskResponse(
  quotaSubject: string,
  responseId: string,
): Promise<void> {
  const redis = createRedisClient();
  if (!redis) return;
  try {
    await withRemoteTimeout(
      redis.eval(
        RECORD_ASK_RESPONSE_SCRIPT,
        [freeAgentActivationStorageKey(quotaSubject)],
        [responseId, String(FREE_AGENT_ASK_INTRO_LIMIT)],
      ),
    );
  } catch (error) {
    logStorageFailure("record", error);
  }
}

const MAX_DEFERRED_REGENERATE_IDS = 256;

/**
 * Validates the optional `deferredRegenerateAssistantIds` request field: the
 * exact assistant chain a free Ask regeneration replaces, deleted by the
 * server only after admission. Absent => existing behavior (undefined).
 */
export function parseDeferredRegenerateAssistantIds(
  value: unknown,
  { regenerate }: { regenerate: boolean },
): string[] | undefined {
  if (value === undefined) return;
  const invalid = (reason: string) =>
    new ChatSDKError(
      "bad_request:api",
      "Invalid deferred regeneration request.",
      {
        invalid_request_field: "deferredRegenerateAssistantIds",
        invalid_request_field_reason: reason,
      },
    );
  if (!regenerate) throw invalid("requires_regenerate");
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_DEFERRED_REGENERATE_IDS
  )
    throw invalid("invalid_length");
  if (
    !value.every(
      (id): id is string =>
        typeof id === "string" &&
        id.trim().length > 0 &&
        id.length <= MAX_RESPONSE_ID_LENGTH,
    )
  )
    throw invalid("invalid_id");
  if (new Set(value).size !== value.length) throw invalid("duplicate_id");
  return value;
}

/**
 * True only when saveMessage acknowledged a durable write (`null`) for the
 * final assistant reply. Fenced/no-op acknowledgements such as "stale_run",
 * and saves of user or other assistant messages, are not receipts.
 */
export function isFinalAssistantSaveReceipt(
  message: { id: string; role: string },
  responseId: string,
  acknowledgement: unknown,
): boolean {
  return (
    message.role === "assistant" &&
    message.id === responseId &&
    acknowledgement === null
  );
}

/**
 * Runs `persist` (the save loop) and counts the response only when it returns
 * a durable receipt for the final assistant message. A rejected save
 * propagates without counting. Only a successful, non-continuation Ask reply
 * with visible text counts; retries of the same response ID count once.
 * Recording failures never affect the saved reply. Returns the receipt.
 */
export async function persistThenRecordFreeAgentAskResponse({
  enrollment,
  mode,
  isAutoContinue,
  succeeded,
  messages,
  responseId,
  persist,
}: {
  enrollment: FreeAgentActivationEnrollment | undefined;
  mode: string;
  isAutoContinue: boolean;
  succeeded: boolean;
  messages: UIMessage[];
  responseId: string;
  /** Resolves true only for a durable save receipt of `responseId`. */
  persist: () => Promise<boolean>;
}): Promise<boolean> {
  const finalAssistantSaved = await persist();
  if (
    finalAssistantSaved === true &&
    enrollment &&
    mode === "ask" &&
    !isAutoContinue &&
    succeeded &&
    responseId.length > 0 &&
    responseId.length <= MAX_RESPONSE_ID_LENGTH &&
    hasCompletedAssistantText(messages, responseId)
  ) {
    await recordCompletedAskResponse(enrollment.quotaSubject, responseId);
  }
  return finalAssistantSaved;
}
