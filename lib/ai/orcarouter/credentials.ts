import "server-only";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { ChatSDKError } from "@/lib/errors";
import { resolveOrcaRouterEndpoints } from "@/lib/ai/orcarouter/config";
import {
  openOrcaRouterSecret,
  sealOrcaRouterSecret,
  isOrcaRouterCredentialStorageConfigured,
} from "@/lib/ai/orcarouter/credential-crypto";
import { createOrcaRouterProvider } from "@/lib/ai/orcarouter/provider";
import { OrcaRouterAuthError } from "@/lib/ai/orcarouter/auth-errors";
import { exchangeOrcaRouterCode, statesMatch } from "@/lib/ai/orcarouter/pkce";

/**
 * One seam for obtaining the user's OrcaRouter key. Pasting an API key and
 * completing "Connect with OrcaRouter" are two adapters that produce the same
 * credential; storage, inference and model discovery never branch on source.
 */

export type OrcaRouterCredentialSource = "api_key" | "pkce";

export type OrcaRouterCredentialInput = {
  key: string;
  source: OrcaRouterCredentialSource;
};

export type OrcaRouterCredential = {
  key: string;
  source: OrcaRouterCredentialSource;
  generation: number;
};

export type OrcaRouterCredentialStatus =
  | { connected: false }
  | {
      connected: true;
      source: OrcaRouterCredentialSource;
      status: "active" | "needs_reauth";
      keyHint: string;
      updatedAt: number;
    };

const MAX_KEY_LENGTH = 512;

export class OrcaRouterCredentialInputError extends Error {}

/** API-key adapter. Format checks only catch obvious paste mistakes. */
export function credentialFromApiKey(raw: unknown): OrcaRouterCredentialInput {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) {
    throw new OrcaRouterCredentialInputError("Enter an OrcaRouter API key.");
  }
  if (key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
    throw new OrcaRouterCredentialInputError(
      "That does not look like an OrcaRouter API key.",
    );
  }
  return { key, source: "api_key" };
}

/** PKCE adapter: verifies `state` before redeeming the code. */
export async function credentialFromPkceCallback({
  authOrigin,
  expectedState,
  verifier,
  params,
  fetchImpl,
}: {
  authOrigin: string;
  expectedState: string;
  verifier: string;
  params: URLSearchParams;
  fetchImpl?: typeof fetch;
}): Promise<OrcaRouterCredentialInput> {
  if (!statesMatch(expectedState, params.get("state"))) {
    throw new OrcaRouterAuthError("state_mismatch");
  }
  if (params.get("error")) throw new OrcaRouterAuthError("access_denied");
  const code = params.get("code");
  if (!code) throw new OrcaRouterAuthError("missing_code");
  const { key } = await exchangeOrcaRouterCode({
    authOrigin,
    code,
    verifier,
    fetchImpl,
  });
  return { key, source: "pkce" };
}

export const getOrcaRouterKeyHint = (key: string) => `…${key.slice(-4)}`;

const serviceKey = () => process.env.CONVEX_SERVICE_ROLE_KEY!;

export async function saveOrcaRouterCredential(
  userId: string,
  input: OrcaRouterCredentialInput,
): Promise<{ generation: number }> {
  return getConvexClient().mutation(api.orcarouterCredentials.saveForBackend, {
    serviceKey: serviceKey(),
    userId,
    encryptedKey: sealOrcaRouterSecret(input.key, userId),
    keyHint: getOrcaRouterKeyHint(input.key),
    source: input.source,
  });
}

export async function clearOrcaRouterCredential(userId: string) {
  await getConvexClient().mutation(api.orcarouterCredentials.clearForBackend, {
    serviceKey: serviceKey(),
    userId,
  });
}

const readCredentialRow = (userId: string) =>
  getConvexClient().query(api.orcarouterCredentials.getForBackend, {
    serviceKey: serviceKey(),
    userId,
  });

export async function getOrcaRouterCredentialStatus(
  userId: string,
): Promise<OrcaRouterCredentialStatus> {
  const row = await readCredentialRow(userId);
  if (!row) return { connected: false };
  return {
    connected: true,
    source: row.source,
    status: row.status,
    keyHint: row.key_hint,
    updatedAt: row.updated_at,
  };
}

/** Returns a usable key, or null when none is stored or it needs reconnecting. */
export async function getActiveOrcaRouterCredential(
  userId: string,
): Promise<OrcaRouterCredential | null> {
  const row = await readCredentialRow(userId);
  if (!row || row.status !== "active") return null;
  return {
    key: openOrcaRouterSecret(row.encrypted_key, userId),
    source: row.source,
    generation: row.generation,
  };
}

/**
 * Terminal reauthentication for a revoked key. Scoped to the generation that
 * made the rejected request, so it cannot affect a newer credential.
 */
export async function markOrcaRouterCredentialNeedsReauth(
  userId: string,
  generation: number,
) {
  try {
    await getConvexClient().mutation(
      api.orcarouterCredentials.markNeedsReauthForBackend,
      { serviceKey: serviceKey(), userId, generation },
    );
  } catch (error) {
    console.error("Failed to mark OrcaRouter credential for reconnect", {
      userId,
      generation,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

export const ORCAROUTER_NOT_CONNECTED_MESSAGE =
  "Connect OrcaRouter in Settings → Model providers to use OrcaRouter models.";
export const ORCAROUTER_RECONNECT_MESSAGE =
  "OrcaRouter rejected the saved key. Reconnect OrcaRouter in Settings → Model providers.";

/**
 * Builds the inference provider for an Ask request that selected an
 * OrcaRouter model. A relay 401 marks exactly this credential generation for
 * reconnection; there is no refresh grant to retry with.
 */
export async function createOrcaRouterProviderForUser(userId: string) {
  if (!isOrcaRouterCredentialStorageConfigured()) {
    throw new ChatSDKError(
      "bad_request:api",
      "OrcaRouter is not enabled on this HackerAI deployment.",
    );
  }
  const row = await readCredentialRow(userId);
  if (!row) {
    throw new ChatSDKError("bad_request:api", ORCAROUTER_NOT_CONNECTED_MESSAGE);
  }
  if (row.status !== "active") {
    throw new ChatSDKError("bad_request:api", ORCAROUTER_RECONNECT_MESSAGE);
  }
  const credential = {
    key: openOrcaRouterSecret(row.encrypted_key, userId),
    generation: row.generation,
  };
  return createOrcaRouterProvider({
    apiKey: credential.key,
    apiBaseUrl: resolveOrcaRouterEndpoints().apiBaseUrl,
    onUnauthorized: () => {
      void markOrcaRouterCredentialNeedsReauth(userId, credential.generation);
    },
  });
}

/**
 * The PKCE verifier and state for an in-flight Connect attempt live only in
 * a short-lived, httpOnly, sealed cookie bound to the signed-in user. They
 * never appear in a URL, log, or the browser's JavaScript.
 */
export const ORCAROUTER_PKCE_COOKIE = "orcarouter_pkce";
export const ORCAROUTER_CALLBACK_PATH = "/api/orcarouter/callback";
export const ORCAROUTER_PKCE_TTL_SECONDS = 10 * 60;

const pendingAttemptContext = (userId: string) => `pkce:${userId}`;

export function sealPendingPkceAttempt(
  userId: string,
  attempt: { verifier: string; state: string },
  now = Date.now(),
): string {
  return sealOrcaRouterSecret(
    JSON.stringify({
      verifier: attempt.verifier,
      state: attempt.state,
      expiresAt: now + ORCAROUTER_PKCE_TTL_SECONDS * 1000,
    }),
    pendingAttemptContext(userId),
  );
}

/** Returns null for a missing, expired, tampered, or other-user attempt. */
export function openPendingPkceAttempt(
  userId: string,
  sealed: string | undefined,
  now = Date.now(),
): { verifier: string; state: string } | null {
  if (!sealed) return null;
  try {
    const value = JSON.parse(
      openOrcaRouterSecret(sealed, pendingAttemptContext(userId)),
    ) as { verifier?: unknown; state?: unknown; expiresAt?: unknown };
    if (
      typeof value.verifier !== "string" ||
      typeof value.state !== "string" ||
      typeof value.expiresAt !== "number" ||
      value.expiresAt <= now
    ) {
      return null;
    }
    return { verifier: value.verifier, state: value.state };
  } catch {
    return null;
  }
}
