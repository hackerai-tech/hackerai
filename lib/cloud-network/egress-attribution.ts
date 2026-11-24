import { createHmac } from "node:crypto";
import type { E2BCluster } from "@/lib/ai/tools/utils/e2b-cluster";
import { createRedisClient } from "@/lib/rate-limit/redis";
import type { ManagedEgress } from "./managed-egress";

/**
 * Per-workspace SOCKS5 credentials on the same regional proxy address.
 * Each region has its own signing key; the proxy's PAM module
 * (scripts/egress/pam_hackerai_egress.c) recomputes the password with that
 * region's key and logs only the opaque owner/workspace references. These
 * domain strings and formats are shared with that module and the test
 * vectors in scripts/egress/tests/credentials.json; change them together.
 */
export const ATTRIBUTED_USERNAME_PREFIX = "hae-";
const OWNER_DOMAIN = "hackerai-egress/v1/owner";
const WORKSPACE_DOMAIN = "hackerai-egress/v1/workspace";
const PASSWORD_DOMAIN = "hackerai-egress/v1/password";
const REGISTRATION_BUDGET_MS = 2_000;
const KEY_HEX = /^[0-9a-f]{64}$/;
/** Bounded provider/WorkOS identifiers; never a separator or control byte. */
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
export const ATTRIBUTION_REF = /^[0-9a-f]{32}$/;

const KEY_ENV: Record<E2BCluster, string> = {
  us: "E2B_EGRESS_ATTRIBUTION_US_KEY",
  eu: "E2B_EGRESS_ATTRIBUTION_EU_KEY",
};
export const ATTRIBUTION_KEY_ENV = Object.values(KEY_ENV);
/** Defined here, not imported, so the telemetry module can import this one. */
const TELEMETRY_KEY_ENV = [
  "E2B_EGRESS_TELEMETRY_US_KEY",
  "E2B_EGRESS_TELEMETRY_EU_KEY",
];

export type EgressAttributionConfig = {
  keys: Record<E2BCluster, Buffer>;
  /** New enrollment. Pinned workspaces are recognized whenever keys exist. */
  enrolled: boolean;
};
/** One region's attribution context, selected with that region's proxy. */
export type RegionAttribution = {
  region: E2BCluster;
  key: Buffer;
  enrolled: boolean;
};
export type AttributedCredential = {
  owner: string;
  workspace: string;
  username: string;
  password: string;
};

/**
 * Read only for accounts already enrolled in managed egress. Like that
 * toggle, E2B_EGRESS_ATTRIBUTION_ENABLED is exactly "true" for every such
 * account, unset/empty/"false" for the E2B_EGRESS_ATTRIBUTION_USERS pilot,
 * and anything else throws. Keys are read even without new enrollment so
 * existing attributed workspaces stay recognized; missing keys mean no
 * attribution at all, partial or malformed keys throw.
 */
export function parseEgressAttribution(
  userId: string,
  env: NodeJS.ProcessEnv,
): EgressAttributionConfig | null {
  const enabled = env.E2B_EGRESS_ATTRIBUTION_ENABLED;
  if (enabled && enabled !== "true" && enabled !== "false")
    throw new Error("Invalid attribution toggle");
  const enrolled =
    enabled === "true" ||
    (env.E2B_EGRESS_ATTRIBUTION_USERS ?? "")
      .split(",")
      .map((id) => id.trim())
      .includes(userId);
  const us = env[KEY_ENV.us] || undefined;
  const eu = env[KEY_ENV.eu] || undefined;
  if (us === undefined && eu === undefined) {
    if (enrolled) throw new Error("Attribution keys are missing");
    return null;
  }
  // Keys are generated independently: never shared across regions or with
  // the telemetry keys configured in the same process.
  const telemetry = TELEMETRY_KEY_ENV.map((name) => env[name]);
  if (
    !KEY_HEX.test(us ?? "") ||
    !KEY_HEX.test(eu ?? "") ||
    us === eu ||
    telemetry.includes(us) ||
    telemetry.includes(eu)
  )
    throw new Error("Invalid attribution keys");
  return {
    keys: { us: Buffer.from(us!, "hex"), eu: Buffer.from(eu!, "hex") },
    enrolled,
  };
}

const hmacHex = (key: Buffer, message: string) =>
  createHmac("sha256", key).update(message, "utf8").digest("hex");

/** Null for identifiers outside the bounded alphabet: they stay unattributed. */
export function attributedCredential(
  key: Buffer,
  region: E2BCluster,
  userId: string,
  sandboxId: string,
): AttributedCredential | null {
  if (!IDENTIFIER.test(userId) || !IDENTIFIER.test(sandboxId)) return null;
  const owner = hmacHex(key, `${OWNER_DOMAIN}\n${userId}`).slice(0, 32);
  const workspace = hmacHex(
    key,
    `${WORKSPACE_DOMAIN}\n${userId}\n${sandboxId}`,
  ).slice(0, 32);
  const username = `${ATTRIBUTED_USERNAME_PREFIX}v1-${owner}-${workspace}`;
  const password = hmacHex(key, `${PASSWORD_DOMAIN}\n${region}\n${username}`);
  return { owner, workspace, username, password };
}

// The registry lets operators resolve an opaque reference to the verified
// owner and sandbox. Acquisition refreshes it; unused entries expire.
export const ATTRIBUTION_REGISTRY_TTL_S = 7 * 24 * 60 * 60;
const workspaceKey = (region: E2BCluster, workspace: string) =>
  `egress-attribution:v1:${region}:workspace:${workspace}`;
const ownerKey = (region: E2BCluster, owner: string) =>
  `egress-attribution:v1:${region}:owner:${owner}`;

export class EgressAttributionConflictError extends Error {
  constructor() {
    super("Egress attribution identity conflict");
    this.name = "EgressAttributionConflictError";
  }
}

type Redis = NonNullable<ReturnType<typeof createRedisClient>>;
/** Claims or refreshes one value; a different existing value is a conflict. */
async function claim(redis: Redis, key: string, value: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (
      await redis.set(key, value, { nx: true, ex: ATTRIBUTION_REGISTRY_TTL_S })
    )
      return;
    const existing = await redis.get<unknown>(key);
    // Expired between the two calls: claim again once.
    if (existing === null) continue;
    if (JSON.stringify(existing) !== value)
      throw new EgressAttributionConflictError();
    await redis.expire(key, ATTRIBUTION_REGISTRY_TTL_S);
    return;
  }
  throw new Error("Attribution registry unavailable");
}

/**
 * Called only after the provider confirmed the workspace's owner. The owner
 * reference maps to exactly one user and the workspace reference to exactly
 * one (user, sandbox); any other existing mapping is rejected.
 */
export async function registerAttributedWorkspace(
  region: E2BCluster,
  credential: AttributedCredential,
  userId: string,
  sandboxId: string,
) {
  const redis = createRedisClient();
  if (!redis) throw new Error("Attribution registry unavailable");
  await claim(
    redis,
    ownerKey(region, credential.owner),
    JSON.stringify({ userId }),
  );
  await claim(
    redis,
    workspaceKey(region, credential.workspace),
    JSON.stringify({ userId, sandboxId, owner: credential.owner }),
  );
}

const ownerUserId = (record: unknown) =>
  record &&
  typeof record === "object" &&
  typeof (record as { userId?: unknown }).userId === "string"
    ? (record as { userId: string }).userId
    : undefined;

/** Verified accounts for several owner references in one read. */
export async function resolveOwners(
  redis: Redis,
  refs: Array<{ region: E2BCluster; owner: string }>,
): Promise<(string | undefined)[]> {
  if (!refs.length) return [];
  const records = await redis.mget<unknown[]>(
    ...refs.map(({ region, owner }) => ownerKey(region, owner)),
  );
  if (records.length !== refs.length)
    throw new Error("Incomplete attribution lookup");
  return records.map(ownerUserId);
}

/**
 * Resolves an owner reference and its workspace references to the verified
 * user and sandbox IDs. Workspaces registered to anyone else, or missing,
 * are counted as unverified rather than reported.
 */
export async function resolveAttribution(
  redis: Redis,
  region: E2BCluster,
  owner: string,
  workspaces: string[],
) {
  const [ownerRecord, ...records] = await redis.mget<unknown[]>(
    ownerKey(region, owner),
    ...workspaces.map((workspace) => workspaceKey(region, workspace)),
  );
  const userId = ownerUserId(ownerRecord);
  const sandboxIds: string[] = [];
  for (const record of records) {
    const value = record as {
      userId?: unknown;
      sandboxId?: unknown;
      owner?: unknown;
    } | null;
    if (
      userId &&
      value?.userId === userId &&
      value.owner === owner &&
      typeof value.sandboxId === "string"
    )
      sandboxIds.push(value.sandboxId);
  }
  return {
    userId,
    sandboxIds: [...new Set(sandboxIds)].sort(),
    unverifiedWorkspaces: workspaces.length - sandboxIds.length,
  };
}

type ProxyReadback = { address: string; username?: string } | undefined;

function logRegistryUnavailable(region: E2BCluster, outcome: string) {
  try {
    console.warn(
      JSON.stringify({
        event: "egress_attribution_registry_unavailable",
        region,
        outcome,
      }),
    );
  } catch {
    /* Diagnostics never change the network decision. */
  }
}

/**
 * Chooses the proxy identity for a workspace whose provider owner was already
 * confirmed. A workspace already carrying its own attributed username stays
 * pinned to it. With enrollment, a workspace with no proxy or with exactly the
 * region's shared address and username moves to its attributed identity once
 * it is registered; `replacesShared` marks that one permitted replacement.
 * Anything else keeps the shared proxy, so the existing comparison rejects a
 * foreign proxy instead of replacing or clearing it.
 */
export async function selectWorkspaceEgress(
  egress: ManagedEgress | null,
  actual: ProxyReadback,
  userId: string,
  sandboxId: string,
): Promise<{ egress: ManagedEgress | null; replacesShared: boolean }> {
  const unchanged = { egress, replacesShared: false };
  const attribution = egress?.attribution;
  if (!egress || !attribution) return unchanged;
  const credential = attributedCredential(
    attribution.key,
    attribution.region,
    userId,
    sandboxId,
  );
  if (!credential) return unchanged;
  const { address } = egress.proxy;
  const pinned =
    actual?.address === address && actual.username === credential.username;
  const shared =
    !actual ||
    (actual.address === address && actual.username === egress.proxy.username);
  if (!pinned && !(attribution.enrolled && shared)) return unchanged;
  try {
    // This optional registry must not stall acquisition during a Redis outage.
    // A late registration can only record the already-verified identity; it
    // cannot change credentials or the provider's network configuration.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        registerAttributedWorkspace(
          attribution.region,
          credential,
          userId,
          sandboxId,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Attribution registry timed out")),
            REGISTRATION_BUDGET_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (error instanceof EgressAttributionConflictError) throw error;
    // Registry outages never block a workspace: an unregistered migration
    // waits for a later acquisition, and a pinned workspace keeps its proxy.
    logRegistryUnavailable(
      attribution.region,
      pinned ? "kept_attributed" : "kept_shared",
    );
    if (!pinned) return unchanged;
  }
  return {
    egress: {
      ...egress,
      proxy: {
        address,
        username: credential.username,
        password: credential.password,
      },
    },
    replacesShared: !pinned && !!actual,
  };
}
