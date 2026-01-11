import { Redis } from "@upstash/redis";

const TRANSFER_TOKEN_TTL_SECONDS = 60;
const OAUTH_STATE_TTL_SECONDS = 300;
const TRANSFER_TOKEN_PREFIX = "desktop-auth-transfer:";
const OAUTH_STATE_PREFIX = "desktop-oauth-state:";
const TOKEN_FORMAT_REGEX = /^[a-f0-9]{64}$/;

type TransferTokenData = {
  sealedSession: string;
  createdAt: number;
};

function getRedis(): Redis | null {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    return null;
  }

  return new Redis({
    url: redisUrl,
    token: redisToken,
  });
}

function generateTransferToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function createDesktopTransferToken(
  sealedSession: string,
): Promise<string | null> {
  const redis = getRedis();
  if (!redis) {
    console.error(
      "[Desktop Auth] Redis not configured, cannot create transfer token",
    );
    return null;
  }

  const transferToken = generateTransferToken();
  const key = `${TRANSFER_TOKEN_PREFIX}${transferToken}`;

  const data: TransferTokenData = {
    sealedSession,
    createdAt: Date.now(),
  };

  try {
    await redis.set(key, JSON.stringify(data), { ex: TRANSFER_TOKEN_TTL_SECONDS });
  } catch (err) {
    console.error("[Desktop Auth] Failed to store transfer token in Redis:", err);
    return null;
  }

  return transferToken;
}

export async function exchangeDesktopTransferToken(
  transferToken: string,
): Promise<{ sealedSession: string } | null> {
  // Validate token format to prevent injection
  if (!TOKEN_FORMAT_REGEX.test(transferToken)) {
    console.warn("[Desktop Auth] Invalid transfer token format");
    return null;
  }

  const redis = getRedis();
  if (!redis) {
    console.error(
      "[Desktop Auth] Redis not configured, cannot exchange transfer token",
    );
    return null;
  }

  const key = `${TRANSFER_TOKEN_PREFIX}${transferToken}`;

  let rawData: string | null;
  try {
    // Use getdel for atomic get-and-delete to prevent race conditions
    rawData = await redis.getdel<string>(key);
  } catch (err) {
    console.error("[Desktop Auth] Failed to retrieve transfer token from Redis:", err);
    return null;
  }

  if (!rawData) {
    console.warn("[Desktop Auth] Transfer token not found or expired");
    return null;
  }

  let data: TransferTokenData;
  try {
    data = JSON.parse(rawData) as TransferTokenData;
  } catch (err) {
    console.error("[Desktop Auth] Failed to parse transfer token data:", err);
    return null;
  }

  if (!data || typeof data.sealedSession !== "string" || data.sealedSession.length === 0) {
    console.error("[Desktop Auth] Invalid transfer token payload");
    return null;
  }

  return {
    sealedSession: data.sealedSession,
  };
}

export async function createOAuthState(): Promise<string | null> {
  const redis = getRedis();
  if (!redis) {
    console.error("[Desktop Auth] Redis not configured, cannot create OAuth state");
    return null;
  }

  const state = generateTransferToken();
  const key = `${OAUTH_STATE_PREFIX}${state}`;

  try {
    await redis.set(key, "1", { ex: OAUTH_STATE_TTL_SECONDS });
  } catch (err) {
    console.error("[Desktop Auth] Failed to store OAuth state in Redis:", err);
    return null;
  }

  return state;
}

export async function verifyAndConsumeOAuthState(state: string): Promise<boolean> {
  if (!TOKEN_FORMAT_REGEX.test(state)) {
    console.warn("[Desktop Auth] Invalid OAuth state format");
    return false;
  }

  const redis = getRedis();
  if (!redis) {
    console.error("[Desktop Auth] Redis not configured, cannot verify OAuth state");
    return false;
  }

  const key = `${OAUTH_STATE_PREFIX}${state}`;

  try {
    const deleted = await redis.del(key);
    return deleted === 1;
  } catch (err) {
    console.error("[Desktop Auth] Failed to verify OAuth state:", err);
    return false;
  }
}
