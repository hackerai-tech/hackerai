import { Redis } from "@upstash/redis";

const TRANSFER_TOKEN_TTL_SECONDS = 300;
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
    await redis.set(key, data, { ex: TRANSFER_TOKEN_TTL_SECONDS });
  } catch (err) {
    console.error(
      "[Desktop Auth] Failed to store transfer token in Redis:",
      err,
    );
    return null;
  }

  return transferToken;
}

export async function exchangeDesktopTransferToken(
  transferToken: string,
): Promise<{ sealedSession: string } | null> {
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

  let rawData: TransferTokenData | string | null;
  try {
    // Use getdel for atomic get-and-delete to prevent race conditions
    rawData = await redis.getdel<TransferTokenData>(key);
  } catch (err) {
    console.error(
      "[Desktop Auth] Failed to retrieve transfer token from Redis:",
      err,
    );
    return null;
  }

  if (!rawData) {
    console.warn("[Desktop Auth] Transfer token not found or expired");
    return null;
  }

  let data: TransferTokenData;
  if (typeof rawData === "object") {
    // Upstash auto-deserialized the JSON
    data = rawData as unknown as TransferTokenData;
  } else {
    try {
      data = JSON.parse(rawData) as TransferTokenData;
    } catch (err) {
      console.error("[Desktop Auth] Failed to parse transfer token data:", err);
      return null;
    }
  }

  if (
    !data ||
    typeof data.sealedSession !== "string" ||
    data.sealedSession.length === 0
  ) {
    console.error("[Desktop Auth] Invalid transfer token payload");
    return null;
  }

  return { sealedSession: data.sealedSession };
}

export type OAuthStateMetadata = {
  devCallbackPort?: number;
};

export async function createOAuthState(
  metadata?: OAuthStateMetadata,
): Promise<string | null> {
  const redis = getRedis();
  if (!redis) {
    console.error(
      "[Desktop Auth] Redis not configured, cannot create OAuth state",
    );
    return null;
  }

  const state = generateTransferToken();
  const key = `${OAUTH_STATE_PREFIX}${state}`;

  const value = metadata ? JSON.stringify(metadata) : "1";

  try {
    await redis.set(key, value, { ex: OAUTH_STATE_TTL_SECONDS });
  } catch (err) {
    console.error("[Desktop Auth] Failed to store OAuth state in Redis:", err);
    return null;
  }

  return state;
}

export async function verifyAndConsumeOAuthState(
  state: string,
): Promise<{ valid: boolean; metadata?: OAuthStateMetadata }> {
  if (!TOKEN_FORMAT_REGEX.test(state)) {
    console.warn("[Desktop Auth] Invalid OAuth state format");
    return { valid: false };
  }

  const redis = getRedis();
  if (!redis) {
    console.error(
      "[Desktop Auth] Redis not configured, cannot verify OAuth state",
    );
    return { valid: false };
  }

  const key = `${OAUTH_STATE_PREFIX}${state}`;

  try {
    const value = await redis.getdel<string>(key);
    if (!value) {
      return { valid: false };
    }

    if (value === "1") {
      return { valid: true };
    }

    try {
      const metadata =
        typeof value === "object"
          ? (value as unknown as OAuthStateMetadata)
          : (JSON.parse(value) as OAuthStateMetadata);
      return { valid: true, metadata };
    } catch {
      // If we can't parse metadata, state is still valid
      return { valid: true };
    }
  } catch (err) {
    console.error("[Desktop Auth] Failed to verify OAuth state:", err);
    return { valid: false };
  }
}
