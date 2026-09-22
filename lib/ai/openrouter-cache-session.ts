import { createHash } from "node:crypto";

const CACHE_SESSION_VERSION = "v1";

/**
 * Builds an opaque, stable OpenRouter sticky-routing key for one model route.
 *
 * Keeping the route in the hash lets a chat return to a previously warmed
 * model without pinning unrelated model selections to the same provider.
 */
export function createOpenRouterCacheSessionId({
  chatId,
  mode,
  requestedModelSlug,
}: {
  chatId: string;
  mode: string;
  requestedModelSlug: string;
}): string {
  const digest = createHash("sha256")
    .update(
      [CACHE_SESSION_VERSION, chatId, mode, requestedModelSlug].join("\u0000"),
    )
    .digest("base64url");

  return `hackerai-cache-${CACHE_SESSION_VERSION}-${digest}`;
}
