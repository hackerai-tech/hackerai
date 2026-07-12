import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ApiError, runs, sessions } from "@trigger.dev/sdk";
import type { NextRequest, NextResponse } from "next/server";
import { AGENT_TOOL_APPROVAL_PROTOCOL_VERSION } from "@/types";

const DEFAULT_AGENT_APPROVAL_TOKEN_EXPIRATION = "15m";
const DEFAULT_TEMPORARY_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const TEMPORARY_REFRESH_COOKIE_NAME = "hai_agent_approval";
const LEGACY_TEMPORARY_REFRESH_COOKIE_PREFIX = "hai_agent_approval_";
const LEGACY_TEMPORARY_REFRESH_PROTOCOL_VERSION = 1;
const TEMPORARY_REFRESH_PROTOCOL_VERSION = 2;
const MAX_TEMPORARY_REFRESH_MAPPINGS = 8;
const MAX_TEMPORARY_REFRESH_COOKIE_VALUE_BYTES = 3500;
const IDEMPOTENT_TRIGGER_CLEANUP_STATUSES = new Set([400, 404, 409, 410, 422]);

export const AGENT_APPROVAL_PROTOCOL_VERSION =
  AGENT_TOOL_APPROVAL_PROTOCOL_VERSION;

const normalizeTokenExpiration = (value: string | undefined): string => {
  if (!value) return DEFAULT_AGENT_APPROVAL_TOKEN_EXPIRATION;
  return /^\d+[smhd]$/.test(value)
    ? value
    : DEFAULT_AGENT_APPROVAL_TOKEN_EXPIRATION;
};

const normalizeRefreshTtlSeconds = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 60
    ? parsed
    : DEFAULT_TEMPORARY_REFRESH_TTL_SECONDS;
};

export const AGENT_APPROVAL_TOKEN_EXPIRATION = normalizeTokenExpiration(
  process.env.AGENT_APPROVAL_TOKEN_EXPIRATION,
);

export const AGENT_TEMPORARY_APPROVAL_REFRESH_TTL_SECONDS =
  normalizeRefreshTtlSeconds(
    process.env.AGENT_TEMPORARY_APPROVAL_REFRESH_TTL_SECONDS,
  );

type TemporaryAgentApprovalRefreshHandle = {
  userId: string;
  chatId: string;
  runId: string;
  approvalSessionId: string;
  expiresAt: number;
};

type TemporaryAgentApprovalRefreshInput = Omit<
  TemporaryAgentApprovalRefreshHandle,
  "expiresAt"
>;

type LegacyTemporaryAgentApprovalRefreshHandle =
  TemporaryAgentApprovalRefreshHandle & {
    version: typeof LEGACY_TEMPORARY_REFRESH_PROTOCOL_VERSION;
  };

type TemporaryAgentApprovalRefreshTuple = [
  userId: string,
  chatId: string,
  runId: string,
  approvalSessionId: string,
  expiresAt: number,
];

type TemporaryAgentApprovalRefreshCollection = {
  version: typeof TEMPORARY_REFRESH_PROTOCOL_VERSION;
  mappings: TemporaryAgentApprovalRefreshTuple[];
};

const getRefreshSecret = (): string | undefined =>
  process.env.AGENT_APPROVAL_REFRESH_SECRET ??
  process.env.CONVEX_SERVICE_ROLE_KEY;

const getLegacyTemporaryRefreshCookieName = (chatId: string): string =>
  `${LEGACY_TEMPORARY_REFRESH_COOKIE_PREFIX}${createHash("sha256")
    .update(chatId)
    .digest("hex")
    .slice(0, 24)}`;

const signTemporaryRefreshPayload = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("base64url");

const encodeSignedTemporaryRefreshPayload = (value: unknown): string => {
  const secret = getRefreshSecret();
  if (!secret) {
    throw new Error("Agent approval refresh secret is not configured");
  }

  const payload = Buffer.from(JSON.stringify(value), "utf8").toString(
    "base64url",
  );
  return `${payload}.${signTemporaryRefreshPayload(payload, secret)}`;
};

const decodeSignedTemporaryRefreshPayload = (value: string): unknown | null => {
  const secret = getRefreshSecret();
  if (!secret) return null;

  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) return null;

  const expectedSignature = signTemporaryRefreshPayload(payload, secret);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

const isTemporaryRefreshHandle = (
  value: unknown,
  now: number,
): value is TemporaryAgentApprovalRefreshHandle => {
  if (!value || typeof value !== "object") return false;
  const handle = value as Partial<TemporaryAgentApprovalRefreshHandle>;
  return (
    typeof handle.userId === "string" &&
    typeof handle.chatId === "string" &&
    typeof handle.runId === "string" &&
    typeof handle.approvalSessionId === "string" &&
    typeof handle.expiresAt === "number" &&
    Number.isFinite(handle.expiresAt) &&
    handle.expiresAt > now
  );
};

const decodeLegacyTemporaryRefreshHandle = (
  value: string,
  now = Date.now(),
): TemporaryAgentApprovalRefreshHandle | null => {
  const parsed = decodeSignedTemporaryRefreshPayload(
    value,
  ) as Partial<LegacyTemporaryAgentApprovalRefreshHandle> | null;
  if (
    parsed?.version !== LEGACY_TEMPORARY_REFRESH_PROTOCOL_VERSION ||
    !isTemporaryRefreshHandle(parsed, now)
  ) {
    return null;
  }
  return parsed;
};

const tupleToTemporaryRefreshHandle = (
  value: unknown,
  now: number,
): TemporaryAgentApprovalRefreshHandle | null => {
  if (!Array.isArray(value) || value.length !== 5) return null;
  const handle = {
    userId: value[0],
    chatId: value[1],
    runId: value[2],
    approvalSessionId: value[3],
    expiresAt: value[4],
  };
  return isTemporaryRefreshHandle(handle, now) ? handle : null;
};

const temporaryRefreshHandleToTuple = (
  handle: TemporaryAgentApprovalRefreshHandle,
): TemporaryAgentApprovalRefreshTuple => [
  handle.userId,
  handle.chatId,
  handle.runId,
  handle.approvalSessionId,
  handle.expiresAt,
];

const decodeTemporaryRefreshMappings = (
  value: string,
  now = Date.now(),
): TemporaryAgentApprovalRefreshHandle[] | null => {
  const parsed = decodeSignedTemporaryRefreshPayload(value);
  if (!parsed || typeof parsed !== "object") return null;

  const record = parsed as Partial<TemporaryAgentApprovalRefreshCollection>;
  if (
    record.version === TEMPORARY_REFRESH_PROTOCOL_VERSION &&
    Array.isArray(record.mappings)
  ) {
    const mappings = record.mappings
      .map((mapping) => tupleToTemporaryRefreshHandle(mapping, now))
      .filter(
        (mapping): mapping is TemporaryAgentApprovalRefreshHandle =>
          mapping !== null,
      );
    return mappings;
  }

  const legacy = decodeLegacyTemporaryRefreshHandle(value, now);
  return legacy ? [legacy] : null;
};

const upsertTemporaryRefreshMapping = (
  mappings: TemporaryAgentApprovalRefreshHandle[],
  mapping: TemporaryAgentApprovalRefreshHandle,
): TemporaryAgentApprovalRefreshHandle[] => [
  ...mappings.filter((current) => current.chatId !== mapping.chatId),
  mapping,
];

const encodeTemporaryRefreshMappings = (
  inputMappings: TemporaryAgentApprovalRefreshHandle[],
): { value: string; mappings: TemporaryAgentApprovalRefreshHandle[] } => {
  const mappings = inputMappings.slice(-MAX_TEMPORARY_REFRESH_MAPPINGS);
  let value = "";
  while (mappings.length > 0) {
    const collection: TemporaryAgentApprovalRefreshCollection = {
      version: TEMPORARY_REFRESH_PROTOCOL_VERSION,
      mappings: mappings.map(temporaryRefreshHandleToTuple),
    };
    value = encodeSignedTemporaryRefreshPayload(collection);
    if (
      Buffer.byteLength(value, "utf8") <=
      MAX_TEMPORARY_REFRESH_COOKIE_VALUE_BYTES
    ) {
      return { value, mappings };
    }
    mappings.shift();
  }
  throw new Error("Agent approval refresh mapping exceeds the cookie limit");
};

const setTemporaryRefreshMappingsCookie = (
  response: NextResponse,
  mappings: TemporaryAgentApprovalRefreshHandle[],
  now = Date.now(),
): void => {
  const encoded = encodeTemporaryRefreshMappings(mappings);
  const expiresAt = Math.max(...encoded.mappings.map((item) => item.expiresAt));
  response.cookies.set({
    name: TEMPORARY_REFRESH_COOKIE_NAME,
    value: encoded.value,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    expires: new Date(expiresAt),
    maxAge: Math.max(0, Math.ceil((expiresAt - now) / 1000)),
  });
};

export const setTemporaryAgentApprovalRefreshCookie = (
  response: NextResponse,
  { req, ...input }: TemporaryAgentApprovalRefreshInput & { req: NextRequest },
): void => {
  const now = Date.now();
  let mappings: TemporaryAgentApprovalRefreshHandle[] = [];

  for (const cookie of req.cookies.getAll()) {
    if (!cookie.name.startsWith(LEGACY_TEMPORARY_REFRESH_COOKIE_PREFIX)) {
      continue;
    }
    const legacy = decodeLegacyTemporaryRefreshHandle(cookie.value, now);
    if (
      legacy &&
      cookie.name === getLegacyTemporaryRefreshCookieName(legacy.chatId)
    ) {
      mappings = upsertTemporaryRefreshMapping(mappings, legacy);
    }
    response.cookies.delete(cookie.name);
  }

  const currentValue = req.cookies.get(TEMPORARY_REFRESH_COOKIE_NAME)?.value;
  if (currentValue) {
    for (const current of decodeTemporaryRefreshMappings(currentValue, now) ??
      []) {
      mappings = upsertTemporaryRefreshMapping(mappings, current);
    }
  }

  mappings = upsertTemporaryRefreshMapping(mappings, {
    ...input,
    expiresAt: now + AGENT_TEMPORARY_APPROVAL_REFRESH_TTL_SECONDS * 1000,
  });
  response.cookies.delete(getLegacyTemporaryRefreshCookieName(input.chatId));
  setTemporaryRefreshMappingsCookie(response, mappings, now);
};

export const getTemporaryAgentApprovalRefreshHandle = ({
  req,
  userId,
  chatId,
}: {
  req: NextRequest;
  userId: string;
  chatId: string;
}): TemporaryAgentApprovalRefreshInput | null => {
  const currentValue = req.cookies.get(TEMPORARY_REFRESH_COOKIE_NAME)?.value;
  const currentMappings = currentValue
    ? (decodeTemporaryRefreshMappings(currentValue) ?? [])
    : [];
  const legacyValue = req.cookies.get(
    getLegacyTemporaryRefreshCookieName(chatId),
  )?.value;
  const legacy = legacyValue
    ? decodeLegacyTemporaryRefreshHandle(legacyValue)
    : null;
  const handle = [...currentMappings, ...(legacy ? [legacy] : [])].find(
    (mapping) => mapping.userId === userId && mapping.chatId === chatId,
  );
  if (handle) {
    return {
      userId: handle.userId,
      chatId: handle.chatId,
      runId: handle.runId,
      approvalSessionId: handle.approvalSessionId,
    };
  }
  return null;
};

export const clearTemporaryAgentApprovalRefreshCookie = (
  response: NextResponse,
  { req, userId, chatId }: { req: NextRequest; userId: string; chatId: string },
): void => {
  const currentCookie = req.cookies.get(TEMPORARY_REFRESH_COOKIE_NAME);
  const currentMappings = currentCookie
    ? decodeTemporaryRefreshMappings(currentCookie.value)
    : null;
  if (currentMappings) {
    const remainingMappings = currentMappings.filter(
      (mapping) => mapping.userId !== userId || mapping.chatId !== chatId,
    );
    if (remainingMappings.length !== currentMappings.length) {
      if (remainingMappings.length > 0) {
        setTemporaryRefreshMappingsCookie(response, remainingMappings);
      } else {
        response.cookies.delete(TEMPORARY_REFRESH_COOKIE_NAME);
      }
    }
  }
  response.cookies.delete(getLegacyTemporaryRefreshCookieName(chatId));
};

const isIdempotentTriggerCleanupError = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.status !== undefined &&
  IDEMPOTENT_TRIGGER_CLEANUP_STATUSES.has(error.status);

export const cancelAgentTriggerRun = async (
  triggerRunId: string | undefined,
): Promise<boolean> => {
  if (!triggerRunId) return false;
  try {
    await runs.cancel(triggerRunId);
  } catch (error) {
    if (!isIdempotentTriggerCleanupError(error)) throw error;
  }
  return true;
};

export const closeAgentApprovalSession = async (
  approvalSessionId: string | undefined,
  reason: string,
): Promise<boolean> => {
  if (!approvalSessionId) return false;
  try {
    await sessions.close(approvalSessionId, { reason });
  } catch (error) {
    if (!isIdempotentTriggerCleanupError(error)) throw error;
  }
  return true;
};
