import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  AgentToolApprovalAuthorization,
  AgentToolApprovalInputRecord,
  SubscriptionTier,
  UnsignedAgentToolApprovalInputRecord,
} from "@/types";
import { AGENT_TOOL_APPROVAL_PROTOCOL_VERSION } from "@/types";

export const AGENT_APPROVAL_AUTHORIZATION_MAX_AGE_MS = 5 * 60 * 1000;
const AGENT_APPROVAL_AUTHORIZATION_MAX_FUTURE_SKEW_MS = 30 * 1000;

export type AgentApprovalAuthorizationErrorCode =
  | "missing_secret"
  | "unsupported_protocol"
  | "invalid_payload"
  | "invalid_signature"
  | "stale_authorization"
  | "authorization_mismatch";

export class AgentApprovalAuthorizationError extends Error {
  constructor(
    readonly code: AgentApprovalAuthorizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentApprovalAuthorizationError";
  }
}

type ApprovalAuthorizationExpectation = {
  userId: string;
  chatId: string;
  runId: string;
  approvalSessionId: string;
  approvalId: string;
  toolCallId: string;
};

const getAuthorizationSecret = (override?: string): string => {
  const secret =
    override ??
    process.env.AGENT_APPROVAL_AUTHORIZATION_SECRET?.trim() ??
    process.env.AGENT_APPROVAL_REFRESH_SECRET?.trim() ??
    process.env.CONVEX_SERVICE_ROLE_KEY?.trim();
  if (!secret) {
    throw new AgentApprovalAuthorizationError(
      "missing_secret",
      "Agent approval authorization signing is not configured.",
    );
  }
  return secret;
};

const getSignaturePayload = (
  input: UnsignedAgentToolApprovalInputRecord,
): string =>
  JSON.stringify([
    input.protocolVersion,
    input.type,
    input.approvalId,
    input.toolCallId,
    input.decision,
    input.grant,
    input.targetPrefix ?? null,
    input.targetKind ?? null,
    input.message ?? null,
    input.at ?? null,
    input.authorization.issuedAt,
    input.authorization.userId,
    input.authorization.chatId,
    input.authorization.runId,
    input.authorization.approvalSessionId,
    input.authorization.subscription,
    input.authorization.organizationId ?? null,
  ]);

const calculateSignature = (
  input: UnsignedAgentToolApprovalInputRecord,
  secret: string,
): string =>
  createHmac("sha256", secret)
    .update(getSignaturePayload(input))
    .digest("base64url");

export const signAgentToolApprovalInput = (
  input: UnsignedAgentToolApprovalInputRecord,
  options: { secret?: string } = {},
): AgentToolApprovalInputRecord => ({
  ...input,
  authorization: {
    ...input.authorization,
    signature: calculateSignature(
      input,
      getAuthorizationSecret(options.secret),
    ),
  },
});

const isSubscriptionTier = (value: unknown): value is SubscriptionTier =>
  value === "free" ||
  value === "pro" ||
  value === "pro-plus" ||
  value === "ultra" ||
  value === "team";

const isApprovalAuthorization = (
  value: unknown,
): value is AgentToolApprovalAuthorization => {
  if (!value || typeof value !== "object") return false;
  const authorization = value as Partial<AgentToolApprovalAuthorization>;
  return (
    typeof authorization.issuedAt === "number" &&
    Number.isFinite(authorization.issuedAt) &&
    typeof authorization.userId === "string" &&
    typeof authorization.chatId === "string" &&
    typeof authorization.runId === "string" &&
    typeof authorization.approvalSessionId === "string" &&
    isSubscriptionTier(authorization.subscription) &&
    (authorization.organizationId === undefined ||
      typeof authorization.organizationId === "string") &&
    typeof authorization.signature === "string"
  );
};

const signaturesMatch = (actual: string, expected: string): boolean => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

export const verifyAgentToolApprovalInputAuthorization = ({
  input,
  expected,
  now = Date.now(),
  secret,
}: {
  input: AgentToolApprovalInputRecord;
  expected: ApprovalAuthorizationExpectation;
  now?: number;
  secret?: string;
}): AgentToolApprovalAuthorization => {
  if (input.protocolVersion !== AGENT_TOOL_APPROVAL_PROTOCOL_VERSION) {
    throw new AgentApprovalAuthorizationError(
      "unsupported_protocol",
      "Unsupported Agent approval protocol version.",
    );
  }
  if (!isApprovalAuthorization(input.authorization)) {
    throw new AgentApprovalAuthorizationError(
      "invalid_payload",
      "Agent approval authorization is incomplete.",
    );
  }

  const { signature, ...unsignedAuthorization } = input.authorization;
  const unsignedInput: UnsignedAgentToolApprovalInputRecord = {
    ...input,
    protocolVersion: input.protocolVersion,
    authorization: unsignedAuthorization,
  };
  const expectedSignature = calculateSignature(
    unsignedInput,
    getAuthorizationSecret(secret),
  );
  if (!signaturesMatch(signature, expectedSignature)) {
    throw new AgentApprovalAuthorizationError(
      "invalid_signature",
      "Agent approval authorization signature is invalid.",
    );
  }

  if (
    input.authorization.issuedAt <
      now - AGENT_APPROVAL_AUTHORIZATION_MAX_AGE_MS ||
    input.authorization.issuedAt >
      now + AGENT_APPROVAL_AUTHORIZATION_MAX_FUTURE_SKEW_MS
  ) {
    throw new AgentApprovalAuthorizationError(
      "stale_authorization",
      "Agent approval authorization is stale.",
    );
  }

  if (
    input.approvalId !== expected.approvalId ||
    input.toolCallId !== expected.toolCallId ||
    input.authorization.userId !== expected.userId ||
    input.authorization.chatId !== expected.chatId ||
    input.authorization.runId !== expected.runId ||
    input.authorization.approvalSessionId !== expected.approvalSessionId
  ) {
    throw new AgentApprovalAuthorizationError(
      "authorization_mismatch",
      "Agent approval authorization does not match this run.",
    );
  }

  return input.authorization;
};
