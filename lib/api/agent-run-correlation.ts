import { createHmac, timingSafeEqual } from "node:crypto";

const AGENT_RUN_CORRELATION_VERSION = "v1";

type AgentRunCorrelationBinding = {
  userId: string;
  chatId: string;
  runId: string;
};

type AgentRunCorrelationOptions = {
  secret?: string;
};

const getAgentRunCorrelationSecret = (
  options?: AgentRunCorrelationOptions,
): string => {
  const secret =
    options?.secret?.trim() ||
    process.env.AGENT_RUN_CORRELATION_SECRET?.trim() ||
    process.env.AGENT_APPROVAL_REFRESH_SECRET?.trim() ||
    process.env.CONVEX_SERVICE_ROLE_KEY?.trim();

  if (!secret) {
    throw new Error("Agent run correlation secret is not configured");
  }

  return secret;
};

const serializeAgentRunCorrelationBinding = ({
  userId,
  chatId,
  runId,
}: AgentRunCorrelationBinding): string =>
  JSON.stringify([AGENT_RUN_CORRELATION_VERSION, userId, chatId, runId]);

const signAgentRunCorrelationBinding = (
  binding: AgentRunCorrelationBinding,
  secret: string,
): string =>
  createHmac("sha256", secret)
    .update(serializeAgentRunCorrelationBinding(binding))
    .digest("base64url");

export const createAgentRunCorrelationToken = (
  binding: AgentRunCorrelationBinding,
  options?: AgentRunCorrelationOptions,
): string => {
  const secret = getAgentRunCorrelationSecret(options);
  const signature = signAgentRunCorrelationBinding(binding, secret);
  return `${AGENT_RUN_CORRELATION_VERSION}.${signature}`;
};

export const verifyAgentRunCorrelationToken = ({
  token,
  ...binding
}: AgentRunCorrelationBinding & {
  token: string;
}): boolean => {
  const [version, signature, extra] = token.split(".");
  if (
    version !== AGENT_RUN_CORRELATION_VERSION ||
    !signature ||
    extra !== undefined
  ) {
    return false;
  }

  const secret = getAgentRunCorrelationSecret();
  const expectedSignature = signAgentRunCorrelationBinding(binding, secret);
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
};
