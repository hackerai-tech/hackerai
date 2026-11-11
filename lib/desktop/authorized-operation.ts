import { createHash, randomBytes } from "node:crypto";
import { createRedisClient } from "@/lib/rate-limit/redis";

const OPERATION_TTL_SECONDS = 90;
const KEY_PREFIX = "desktop:authorized-operation:";

export type AuthorizedDesktopOperation = {
  userId: string;
  connectionId: string;
  digest: string;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function desktopOperationDigest(
  payload: Record<string, unknown>,
): string {
  const transported = JSON.parse(JSON.stringify(payload)) as Record<
    string,
    unknown
  >;
  return createHash("sha256").update(canonicalJson(transported)).digest("hex");
}

/** Only the server dispatch path creates these single-use native operations. */
export async function authorizeDesktopOperation(
  userId: string,
  connectionId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const redis = createRedisClient();
  if (!redis) throw new Error("Desktop operation authorization is unavailable");
  const id = randomBytes(32).toString("hex");
  await redis.set(
    `${KEY_PREFIX}${id}`,
    {
      userId,
      connectionId,
      digest: desktopOperationDigest(payload),
    } satisfies AuthorizedDesktopOperation,
    { ex: OPERATION_TTL_SECONDS },
  );
  return id;
}

/** Redemption is atomic: a relay replay cannot execute the same operation twice. */
export async function redeemDesktopOperation(
  id: string,
): Promise<AuthorizedDesktopOperation | null> {
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  const redis = createRedisClient();
  if (!redis) return null;
  const operation = await redis.getdel<AuthorizedDesktopOperation>(
    `${KEY_PREFIX}${id}`,
  );
  if (
    !operation ||
    typeof operation.userId !== "string" ||
    typeof operation.connectionId !== "string" ||
    typeof operation.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(operation.digest)
  ) {
    return null;
  }
  return operation;
}
