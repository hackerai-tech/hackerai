import { WorkOS } from "@workos-inc/node";

/**
 * Bound for WorkOS calls made while a page or API request waits. The SDK
 * default (60s per attempt, then 3 retries of timeouts, 429s and 5xx) can hold
 * a request until the platform limit during a WorkOS stall. 4s per attempt and
 * one retry end a stalled call in under 10s and still absorb one transient
 * failure; a retried session refresh stays inside WorkOS's 30s refresh-token
 * replay window. A Retry-After header from WorkOS can still delay that one
 * retry, capped by the SDK at 60s.
 *
 * AuthKit's own client uses the same values through
 * patches/@workos-inc__authkit-nextjs@4.3.2.patch.
 */
export const WORKOS_REQUEST_TIMEOUT_MS = 4_000;
export const WORKOS_REQUEST_MAX_RETRIES = 1;

let workosClient: WorkOS | null = null;

export function getWorkOS(): WorkOS {
  if (workosClient) return workosClient;

  const apiKey = process.env.WORKOS_API_KEY;
  const clientId = process.env.WORKOS_CLIENT_ID;
  if (!apiKey || !clientId) {
    throw new Error("WORKOS_API_KEY and WORKOS_CLIENT_ID must be configured");
  }

  workosClient = new WorkOS(apiKey, {
    clientId,
    timeout: WORKOS_REQUEST_TIMEOUT_MS,
    maxRetries: WORKOS_REQUEST_MAX_RETRIES,
  });
  return workosClient;
}

export const workos = new Proxy({} as WorkOS, {
  get(_target, prop) {
    const client = getWorkOS();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
