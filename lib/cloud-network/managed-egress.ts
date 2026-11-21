import { z } from "zod";
import type { E2BCluster } from "@/lib/ai/tools/utils/e2b-cluster";
import { e2bNetwork, type NetworkPolicy } from "./policy";
import {
  ATTRIBUTED_USERNAME_PREFIX,
  parseEgressAttribution,
  type EgressAttributionConfig,
  type RegionAttribution,
} from "./egress-attribution";

/**
 * Server-managed E2B egress, enabled for every account or for exact pilot
 * accounts. Configuration is read from server-only environment variables and
 * never stored in, or returned with, the user's saved network settings.
 */
type EgressProxy = { address: string; username: string; password: string };
/**
 * `"*"` is general egress: the saved policy maps exactly as without a proxy.
 * A list is the pilot's operator hostname allowlist.
 */
type Destinations = "*" | string[];
/** Validated configuration for both E2B clusters. */
export type ManagedEgressConfig = {
  proxies: Record<E2BCluster, EgressProxy>;
  destinations: Destinations;
  attribution: EgressAttributionConfig | null;
};
/**
 * The egress for one workspace, selected by the cluster that hosts it. `proxy`
 * is the region's shared identity; attribution may replace only its username
 * and password once the workspace's owner is confirmed.
 */
export type ManagedEgress = {
  proxy: EgressProxy;
  destinations: Destinations;
  attribution: RegionAttribution | null;
};
type ProxyReadback = { address: string; username?: string } | undefined;

/** Each E2B cluster tunnels only through its own region's proxy. */
const PROXY_ENV: Record<E2BCluster, string> = {
  us: "E2B_MANAGED_EGRESS_US_PROXY",
  eu: "E2B_MANAGED_EGRESS_EU_PROXY",
};

/** Deliberately generic: never describe which value was missing or invalid. */
export class ManagedEgressUnavailableError extends Error {
  constructor() {
    super("Managed network egress is unavailable for this account.");
    this.name = "ManagedEgressUnavailableError";
  }
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_DESTINATIONS = 100;
const ALL_TRAFFIC = "0.0.0.0/0";

/** Lowercase multi-label DNS name with no wildcard, port, path or IP form. */
function isCanonicalDnsName(value: string) {
  const labels = value.split(".");
  return (
    value.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => DNS_LABEL.test(label)) &&
    !/^\d+$/.test(labels[labels.length - 1]) &&
    // The URL parser also recognizes alternate numeric IP spellings.
    URL.parse(`https://${value}`)?.hostname === value
  );
}
function isCanonicalIPv4(value: string) {
  const octets = value.split(".");
  return (
    octets.length === 4 &&
    octets.every(
      (octet) =>
        /^\d{1,3}$/.test(octet) && String(+octet) === octet && +octet <= 255,
    )
  );
}
function isProxyAddress(value: string) {
  const match = /^([^:]+):(\d{1,5})$/.exec(value);
  if (!match) return false;
  const port = Number(match[2]);
  return (
    String(port) === match[2] &&
    port >= 1 &&
    port <= 65_535 &&
    (isCanonicalDnsName(match[1]) || isCanonicalIPv4(match[1]))
  );
}
const socksCredential = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 255);
const proxySchema = z
  .object({
    address: z.string().refine(isProxyAddress),
    username: socksCredential,
    password: socksCredential,
  })
  .strict();

/**
 * E2B_MANAGED_EGRESS_ENABLED=true enrolls every account. Unset, empty or
 * "false" keeps the exact pilot list. Any other value throws: a mistyped
 * global toggle must not silently route everyone through direct egress.
 */
function isEnrolled(userId: string, env: NodeJS.ProcessEnv) {
  const enabled = env.E2B_MANAGED_EGRESS_ENABLED;
  if (enabled === "true") return true;
  if (enabled && enabled !== "false") throw new ManagedEgressUnavailableError();
  return new Set(
    (env.E2B_MANAGED_EGRESS_USERS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  ).has(userId);
}

const proxyHost = ({ address }: EgressProxy) =>
  address.slice(0, address.lastIndexOf(":"));

function parseDestinations(value = ""): Destinations {
  const destinations = value.split(",").map((entry) => entry.trim());
  // "*" is valid only alone; mixed with hostnames it is ambiguous.
  if (destinations.length === 1 && destinations[0] === "*") return "*";
  // An unset or empty list yields [""], which is rejected like any other
  // non-canonical entry.
  if (
    destinations.length > MAX_DESTINATIONS ||
    !destinations.every(isCanonicalDnsName)
  )
    throw new Error("Invalid destinations");
  return [...new Set(destinations)].sort();
}

/**
 * Returns null, without reading the proxy configuration, for every account
 * that is not enrolled. An enrolled account needs both regional proxies, on
 * distinct hosts, and valid destinations whichever region it uses: missing or
 * malformed configuration throws, so it never falls back to direct egress.
 */
export function resolveManagedEgress(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): ManagedEgressConfig | null {
  if (!isEnrolled(userId, env)) return null;
  try {
    const proxies = {
      us: proxySchema.parse(JSON.parse(env[PROXY_ENV.us] ?? "")),
      eu: proxySchema.parse(JSON.parse(env[PROXY_ENV.eu] ?? "")),
    };
    // One host cannot provide two regional source IPs.
    if (proxyHost(proxies.us) === proxyHost(proxies.eu))
      throw new Error("Regional proxies share a host");
    const attribution = parseEgressAttribution(userId, env);
    // The proxy rejects a reserved name outright, never as a shared login.
    if (
      attribution &&
      [proxies.us, proxies.eu].some(({ username }) =>
        username.startsWith(ATTRIBUTED_USERNAME_PREFIX),
      )
    )
      throw new Error("Shared username uses the attributed prefix");
    return {
      proxies,
      destinations: parseDestinations(env.E2B_MANAGED_EGRESS_DESTINATIONS),
      attribution,
    };
  } catch {
    throw new ManagedEgressUnavailableError();
  }
}

/**
 * Selects the proxy of the E2B cluster that hosts the workspace. Callers pass
 * the cluster chosen by Trigger region routing or the inventory being listed,
 * never one inferred from the user or provider metadata. There is no
 * cross-region fallback.
 */
export function managedEgressForCluster(
  config: ManagedEgressConfig | null,
  cluster: E2BCluster,
): ManagedEgress | null {
  if (!config) return null;
  if (!Object.hasOwn(config.proxies, cluster))
    throw new ManagedEgressUnavailableError();
  const { attribution } = config;
  return {
    proxy: config.proxies[cluster],
    destinations: config.destinations,
    attribution: attribution && {
      region: cluster,
      key: attribution.keys[cluster],
      enrolled: attribution.enrolled,
    },
  };
}

/** A saved entry covers an operator destination only by exact host or wildcard subdomain. */
function covers(entry: string, destination: string) {
  return entry.startsWith("*.")
    ? destination.endsWith(entry.slice(1))
    : entry === destination;
}

/**
 * The single desired E2B network for create, Settings saves and acquisition.
 * Non-enrolled accounts keep the existing mapping exactly. General egress
 * ("*") keeps that same mapping and only adds the proxy. With an operator
 * list, the network is deny-all plus listed destinations narrowed by the saved
 * policy; saved IPs/CIDRs never grant anything. Offline stays deny-all in both
 * modes. The proxy is always present so E2B's full-replacement update never
 * drops tunneling.
 */
export function desiredE2BNetwork(
  policy: NetworkPolicy,
  egress: ManagedEgress | null,
) {
  if (!egress) return e2bNetwork(policy);
  const { destinations } = egress;
  if (destinations === "*")
    return { ...e2bNetwork(policy), egressProxy: { ...egress.proxy } };
  const allowOut =
    policy.mode === "offline"
      ? []
      : destinations.filter(
          (destination) =>
            policy.mode === "unrestricted" ||
            policy.allow.some((entry) => covers(entry, destination)),
        );
  return {
    allowOut,
    denyOut: [ALL_TRAFFIC],
    egressProxy: { ...egress.proxy },
  };
}

/**
 * Compares E2B's masked proxy readback (the password is never returned).
 * Returns false when the desired proxy is absent so the writer can set it.
 * Any other present proxy is foreign and is rejected, never replaced or cleared.
 */
export function hasDesiredEgressProxy(
  actual: ProxyReadback,
  egress: ManagedEgress | null,
) {
  if (!actual) return !egress;
  if (
    !egress ||
    actual.address !== egress.proxy.address ||
    actual.username !== egress.proxy.username
  )
    throw new Error("Externally managed network configuration");
  return true;
}
