import "server-only";

import { Resolver } from "node:dns";
import { BlockList, isIPv4 } from "node:net";
import type { AnySandbox } from "@/types";
import { isE2BSandbox } from "@/lib/ai/tools/utils/sandbox-types";

const NETWORK_INFO_TIMEOUT_MS = 5_000;
const LOOKUP_TIMEOUT_MS = 2_000;
const LOOKUP_DEADLINE_MS = 3_000;
const MAX_ANSWERS = 16;

// A lowercase multi-label DNS name. IP literals, single labels and anything a
// URL parser had to normalize are left to the ordinary transfer.
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Private, loopback, link-local, shared (CGN), multicast, reserved and
// documentation/benchmark networks are never pinned.
const nonPublic = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  nonPublic.addSubnet(network, prefix, "ipv4");

/**
 * Run one bounded step. Resolves undefined when the step fails or exceeds its
 * deadline, so the caller keeps its original failure; rejects only with the
 * Stop reason. The step's signal aborts on Stop or deadline expiry.
 */
function settleWithin<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  start: (bounded: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const controller = new AbortController();
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => {
      finish(() => reject(signal!.reason));
      controller.abort(signal!.reason);
    };
    const timer = setTimeout(() => {
      finish(() => resolve(undefined));
      controller.abort();
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return start(controller.signal);
      })
      .then(
        (value) => finish(() => resolve(value)),
        () => finish(() => resolve(undefined)),
      );
  });
}

/** The exact HTTPS/443 authority curl will use, or null when not pinnable. */
function pinnableHostname(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    parsed.username ||
    parsed.password ||
    !HOSTNAME.test(parsed.hostname)
  )
    return null;
  // The raw text must spell the same authority, so curl's own URL parser
  // cannot read a different host than the one resolved here.
  const origin = `https://${parsed.hostname}`;
  return url.startsWith(origin) &&
    /^(?::443)?(?:[/?#]|$)/.test(url.slice(origin.length))
    ? parsed.hostname
    : null;
}

const isEmptyList = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.length === 0);

/** Only an explicit network description without any egress control passes. */
function hasOpenEgress(info: unknown): boolean {
  if (!info || typeof info !== "object") return false;
  const { network, allowInternetAccess } = info as Record<string, unknown>;
  if (allowInternetAccess === false) return false;
  if (!network || typeof network !== "object" || Array.isArray(network))
    return false;
  const { allowOut, denyOut, egressProxy, rules } = network as Record<
    string,
    unknown
  >;
  return (
    isEmptyList(allowOut) &&
    isEmptyList(denyOut) &&
    egressProxy == null &&
    (rules == null ||
      (typeof rules === "object" &&
        !Array.isArray(rules) &&
        (rules instanceof Map ? rules.size : Object.keys(rules).length) === 0))
  );
}

function selectPublicAddress(records: unknown): string | null {
  if (
    !Array.isArray(records) ||
    records.length === 0 ||
    records.length > MAX_ANSWERS
  )
    return null;
  // One non-public answer disqualifies the name rather than being skipped.
  return records.every(
    (address) =>
      typeof address === "string" &&
      isIPv4(address) &&
      !nonPublic.check(address, "ipv4"),
  )
    ? records[0]
    : null;
}

/**
 * The step that settled the pin, from values already evaluated. Not network
 * proof: `network_not_verified_open` includes unknown or malformed state, and
 * `address_not_public` includes empty, oversized or invalid answers.
 */
export type CloudAttachmentDnsDecision =
  | "url_not_pinnable"
  | "sandbox_unsupported"
  | "get_info_missing"
  | "network_info_unavailable"
  | "network_not_verified_open"
  | "resolution_unavailable"
  | "address_not_public"
  | "pin_available";

/**
 * Resolve a cloud attachment host on the worker for one `curl --resolve`
 * retry after the workspace's own resolver failed. Returns `host:443:address`
 * or null when the retry must not happen.
 *
 * The pin never widens what the workspace may reach: it is offered only when
 * the provider reports the workspace's egress as unrestricted, and only for
 * a public IPv4 address of the URL's own HTTPS host. Unknown, failed or
 * restricted network state and every resolver failure return null. Only Stop
 * rejects, with its original reason, and reports no decision.
 */
export async function resolveCloudAttachmentDnsPin(
  sandbox: AnySandbox,
  url: string,
  signal?: AbortSignal,
  onDecision?: (decision: CloudAttachmentDnsDecision) => void,
): Promise<string | null> {
  const decide = (decision: CloudAttachmentDnsDecision) => {
    try {
      onDecision?.(decision);
    } catch {
      // An optional observer must not change the pin.
    }
  };
  signal?.throwIfAborted();
  const hostname = pinnableHostname(url);
  if (!hostname) {
    decide("url_not_pinnable");
    return null;
  }
  if (!isE2BSandbox(sandbox)) {
    decide("sandbox_unsupported");
    return null;
  }
  if (typeof sandbox.getInfo !== "function") {
    decide("get_info_missing");
    return null;
  }

  const info = await settleWithin(NETWORK_INFO_TIMEOUT_MS, signal, (bounded) =>
    sandbox.getInfo({
      signal: bounded,
      requestTimeoutMs: NETWORK_INFO_TIMEOUT_MS,
    }),
  );
  if (info === undefined) {
    decide("network_info_unavailable");
    return null;
  }
  if (!hasOpenEgress(info)) {
    decide("network_not_verified_open");
    return null;
  }

  const records = await settleWithin(
    LOOKUP_DEADLINE_MS,
    signal,
    (bounded) =>
      new Promise<unknown>((resolve) => {
        // A resolver owned by this call: cancelling it or bounding its
        // timeout cannot affect any other lookup in the process.
        const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 });
        bounded.addEventListener("abort", () => resolver.cancel(), {
          once: true,
        });
        resolver.resolve4(hostname, (error, addresses) =>
          resolve(error ? undefined : addresses),
        );
      }),
  );
  if (records === undefined) {
    decide("resolution_unavailable");
    return null;
  }
  const address = selectPublicAddress(records);
  decide(address ? "pin_available" : "address_not_public");
  return address ? `${hostname}:443:${address}` : null;
}
