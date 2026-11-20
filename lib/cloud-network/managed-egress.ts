import { z } from "zod";
import type { E2BCluster } from "@/lib/ai/tools/utils/e2b-cluster";
import { e2bNetwork, type NetworkPolicy } from "./policy";

/**
 * Server-managed E2B egress pilot for exact internal accounts. Configuration is
 * read from server-only environment variables and never stored in, or returned
 * with, the user's saved network settings.
 */
type EgressProxy = { address: string; username: string; password: string };
/** The pilot's validated configuration for both E2B clusters. */
export type ManagedEgressConfig = {
  proxies: Record<E2BCluster, EgressProxy>;
  destinations: string[];
};
/** The egress for one workspace, selected by the cluster that hosts it. */
export type ManagedEgress = { proxy: EgressProxy; destinations: string[] };
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

function enrolledUsers(env: NodeJS.ProcessEnv) {
  return new Set(
    (env.E2B_MANAGED_EGRESS_USERS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

const proxyHost = ({ address }: EgressProxy) =>
  address.slice(0, address.lastIndexOf(":"));

/**
 * Returns null for every account not listed exactly in E2B_MANAGED_EGRESS_USERS,
 * without reading the proxy configuration. An enrolled account needs both
 * regional proxies, on distinct hosts, whichever region it uses: missing or
 * malformed configuration throws, so it never falls back to direct egress.
 */
export function resolveManagedEgress(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): ManagedEgressConfig | null {
  if (!enrolledUsers(env).has(userId)) return null;
  try {
    const proxies = {
      us: proxySchema.parse(JSON.parse(env[PROXY_ENV.us] ?? "")),
      eu: proxySchema.parse(JSON.parse(env[PROXY_ENV.eu] ?? "")),
    };
    // One host cannot provide two regional source IPs.
    if (proxyHost(proxies.us) === proxyHost(proxies.eu))
      throw new Error("Regional proxies share a host");
    const destinations = (env.E2B_MANAGED_EGRESS_DESTINATIONS ?? "")
      .split(",")
      .map((entry) => entry.trim());
    // An unset or empty list yields [""], which is rejected like any other
    // non-canonical entry.
    if (
      destinations.length > MAX_DESTINATIONS ||
      !destinations.every(isCanonicalDnsName)
    )
      throw new Error("Invalid destinations");
    return { proxies, destinations: [...new Set(destinations)].sort() };
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
  return { proxy: config.proxies[cluster], destinations: config.destinations };
}

/** A saved entry covers an operator destination only by exact host or wildcard subdomain. */
function covers(entry: string, destination: string) {
  return entry.startsWith("*.")
    ? destination.endsWith(entry.slice(1))
    : entry === destination;
}

/**
 * The single desired E2B network for create, Settings saves and acquisition.
 * Non-enrolled accounts keep the existing mapping exactly. Enrolled accounts
 * are deny-all plus operator destinations narrowed by the saved policy; saved
 * IPs/CIDRs never grant anything, and offline stays deny-all. The proxy is
 * always present so E2B's full-replacement update never drops tunneling.
 */
export function desiredE2BNetwork(
  policy: NetworkPolicy,
  egress: ManagedEgress | null,
) {
  if (!egress) return e2bNetwork(policy);
  const allowOut =
    policy.mode === "offline"
      ? []
      : egress.destinations.filter(
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
