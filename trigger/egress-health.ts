import { Sandbox } from "@e2b/code-interpreter";
import { logger, schedules } from "@trigger.dev/sdk";
import {
  DEFAULT_TRIGGER_RUN_REGION,
  EUROPE_TRIGGER_RUN_REGION,
  type TriggerRunRegion,
} from "@/lib/api/trigger-region";
import {
  E2B_EU_DOMAIN,
  getE2BClusterRouting,
  type E2BCluster,
  type E2BConnectionOptions,
} from "@/lib/ai/tools/utils/e2b-cluster";
import { CURRENT_E2B_SANDBOX_VERSION } from "@/lib/ai/tools/utils/e2b-sandbox-version";
import {
  managedEgressForCluster,
  resolveManagedEgress,
} from "@/lib/cloud-network/managed-egress";
import { createRedisClient } from "@/lib/rate-limit/redis";

// Defensive synthetic check of each region's managed egress: a disposable
// sandbox on that region's E2B cluster and proxy makes one fixed HTTPS request
// to an endpoint HackerAI owns, and the reported source IP must equal the
// region's independently configured static IP. It never routes customer work.
export const EGRESS_PROBE_HOST = "convex.haiusercontent.com";
const PROBE_URL = `https://${EGRESS_PROBE_HOST}/cdn-cgi/trace`;
const INTERVAL_MS = 5 * 60_000;
const MAX_DURATION_S = 120;

/**
 * Nested limits: curl's own deadline ends before the E2B command deadline, the
 * create/command/kill requests fit inside the run, and the sandbox outlives
 * the probe but not the run, so an abandoned one is killed at its TTL.
 */
export const PROBE_BUDGETS = {
  createRequestMs: 30_000,
  commandMs: 25_000,
  curlConnectS: 10,
  curlMaxTimeS: 20,
  maxResponseBytes: 4096,
  killRequestMs: 15_000,
  sandboxTtlMs: MAX_DURATION_S * 1000,
};
type ProbeBudgets = typeof PROBE_BUDGETS;

const budgetsAreConsistent = (b: ProbeBudgets) =>
  Object.values(b).every((value) => Number.isInteger(value) && value > 0) &&
  b.curlConnectS < b.curlMaxTimeS &&
  b.curlMaxTimeS * 1000 < b.commandMs &&
  b.commandMs + b.killRequestMs <= b.sandboxTtlMs &&
  b.createRequestMs + b.commandMs + b.killRequestMs < MAX_DURATION_S * 1000 &&
  b.sandboxTtlMs <= MAX_DURATION_S * 1000;

// -q ignores any curlrc; --noproxy keeps curl on the sandbox's own network
// path, which E2B tunnels through the managed proxy. HTTPS only, IPv4 only so
// the reported address is comparable, and never follows a redirect.
const probeCommand = (b: ProbeBudgets) =>
  [
    "curl -q --silent --fail --ipv4 --proto =https --max-redirs 0",
    "--noproxy '*'",
    `--connect-timeout ${b.curlConnectS} --max-time ${b.curlMaxTimeS}`,
    `--max-filesize ${b.maxResponseBytes}`,
    PROBE_URL,
  ].join(" ");

const MONITORS: Record<
  E2BCluster,
  { triggerRegion: TriggerRunRegion; expectedIpEnv: string }
> = {
  us: {
    triggerRegion: DEFAULT_TRIGGER_RUN_REGION,
    expectedIpEnv: "E2B_EGRESS_MONITOR_US_IP",
  },
  eu: {
    triggerRegion: EUROPE_TRIGGER_RUN_REGION,
    expectedIpEnv: "E2B_EGRESS_MONITOR_EU_IP",
  },
};

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

type FailureReason =
  "configuration" | "wrong_ip" | "unavailable" | "cleanup" | "state";
const FAILURE_MESSAGES: Record<FailureReason, string> = {
  configuration: "monitor configuration is missing or invalid",
  wrong_ip: "observed source IP does not match the expected static IP",
  unavailable: "probe unavailable in consecutive checks",
  cleanup: "test sandbox cleanup failed",
  state: "unavailable streak could not be recorded",
};

/** Messages are fixed text: never provider errors, output or configuration. */
export class EgressHealthError extends Error {
  constructor(
    readonly region: E2BCluster,
    readonly reasons: FailureReason[],
  ) {
    super(
      `${region.toUpperCase()} egress health: ${reasons
        .map((reason) => FAILURE_MESSAGES[reason])
        .join("; ")}`,
    );
    this.name = "EgressHealthError";
  }
}

/**
 * Exactly one `ip=` line holding a canonical IPv4 address; anything else,
 * including oversized output, is treated as no answer.
 */
export function parseTraceIp(body: string, maxBytes: number): string | null {
  if (Buffer.byteLength(body, "utf8") > maxBytes) return null;
  const ips = body
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.startsWith("ip="));
  if (ips.length !== 1) return null;
  const ip = ips[0].slice("ip=".length);
  return IPV4.test(ip) ? ip : null;
}

/**
 * Unset, empty or "false" leaves the monitor off. Any other value but exactly
 * "true" is a configuration error, as with the managed egress toggle.
 */
function monitorEnabled(region: E2BCluster) {
  const value = process.env.E2B_EGRESS_MONITOR_ENABLED;
  if (value === "true") return true;
  if (!value || value === "false") return false;
  throw new EgressHealthError(region, ["configuration"]);
}

/** Validates everything before any provider call; failures are generic. */
function resolveProbeSetup(region: E2BCluster, budgets: ProbeBudgets) {
  try {
    const monitor = MONITORS[region];
    if (!budgetsAreConsistent(budgets)) throw new Error();
    // Only the global mode proves every account routes through these
    // proxies; a pilot list would make the monitor's identity matter.
    if (process.env.E2B_MANAGED_EGRESS_ENABLED !== "true") throw new Error();
    const cluster = getE2BClusterRouting(monitor.triggerRegion).createCluster;
    if (cluster.cluster !== region) throw new Error();
    const euDomain = process.env.E2B_EU_DOMAIN?.trim() || E2B_EU_DOMAIN;
    // US customer sandboxes use the process key and default domain; make that
    // explicit so a US probe can never reach the EU cluster.
    const connection: E2BConnectionOptions | undefined =
      region === "us"
        ? {
            apiKey: process.env.E2B_API_KEY?.trim() ?? "",
            domain: process.env.E2B_DOMAIN?.trim() || "e2b.app",
          }
        : cluster.connectionOptions;
    if (!connection?.apiKey) throw new Error();
    if (region === "us" && connection.domain === euDomain) throw new Error();
    // With general mode the user ID is never consulted.
    const egress = managedEgressForCluster(
      resolveManagedEgress("egress-health-monitor"),
      region,
    );
    if (!egress) throw new Error();
    // A hostname list is also enforced on the proxy; the probe must be on it.
    if (
      egress.destinations !== "*" &&
      !egress.destinations.some((host) => host === EGRESS_PROBE_HOST)
    )
      throw new Error();
    const expectedIp = process.env[monitor.expectedIpEnv] ?? "";
    if (!IPV4.test(expectedIp)) throw new Error();
    const redis = createRedisClient();
    if (!redis) throw new Error();
    return {
      template: `${cluster.template.split(":")[0]}:${CURRENT_E2B_SANDBOX_VERSION}`,
      connection,
      // Deny-all with the single probe host, whatever the configured
      // destinations are, and always through this region's proxy.
      network: {
        allowOut: [EGRESS_PROBE_HOST],
        denyOut: ["0.0.0.0/0"],
        egressProxy: { ...egress.proxy },
      },
      expectedIp,
      redis,
    };
  } catch {
    throw new EgressHealthError(region, ["configuration"]);
  }
}
type ProbeSetup = ReturnType<typeof resolveProbeSetup>;

type ProbeOutcome =
  | { kind: "observed"; ip: string }
  | { kind: "unavailable"; stage: "create" | "command" | "response" };

/** One sandbox, one command, no retries. Cleanup is always awaited. */
async function probeEgress(
  setup: ProbeSetup,
  budgets: ProbeBudgets,
): Promise<{ outcome: ProbeOutcome; cleanupFailed: boolean }> {
  let sandbox: Sandbox;
  try {
    // A failed create response can hide a created sandbox; its TTL kills it.
    sandbox = await Sandbox.create(setup.template, {
      ...setup.connection,
      network: setup.network,
      retries: 0,
      requestTimeoutMs: budgets.createRequestMs,
      timeoutMs: budgets.sandboxTtlMs,
      lifecycle: { onTimeout: "kill" },
      secure: true,
      metadata: { purpose: "egress-health" },
    });
  } catch {
    return {
      outcome: { kind: "unavailable", stage: "create" },
      cleanupFailed: false,
    };
  }

  let outcome: ProbeOutcome;
  try {
    const result = await sandbox.commands.run(probeCommand(budgets), {
      timeoutMs: budgets.commandMs,
      requestTimeoutMs: budgets.commandMs,
    });
    const ip = parseTraceIp(result.stdout, budgets.maxResponseBytes);
    outcome = ip
      ? { kind: "observed", ip }
      : { kind: "unavailable", stage: "response" };
  } catch {
    outcome = { kind: "unavailable", stage: "command" };
  }

  try {
    await sandbox.kill({ requestTimeoutMs: budgets.killRequestMs });
    return { outcome, cleanupFailed: false };
  } catch {
    return { outcome, cleanupFailed: true };
  }
}

// Each scheduled window marks its own unavailable result. SET NX keeps
// duplicate runs in one window from counting twice; the streak is consecutive
// when the previous window is also marked. The TTL outlives the next check.
const STREAK_TTL_S = (3 * INTERVAL_MS) / 1000;
const unavailableKey = (region: E2BCluster, window: number) =>
  `egress-health:${region}:unavailable:${window}`;

export type EgressHealthResult = {
  region: E2BCluster;
  status: "disabled" | "healthy" | "unavailable";
};

/**
 * Wrong IP fails immediately. Unavailable fails from the second consecutive
 * scheduled window. Missing setup and failed cleanup fail the run. Disabled
 * returns without reading other configuration or calling any service.
 */
export async function runEgressHealthCheck(
  region: E2BCluster,
  scheduledAt: Date,
  budgets: ProbeBudgets = PROBE_BUDGETS,
): Promise<EgressHealthResult> {
  if (!monitorEnabled(region)) return { region, status: "disabled" };
  const slot = Math.floor(new Date(scheduledAt).getTime() / INTERVAL_MS);
  if (!Number.isSafeInteger(slot))
    throw new EgressHealthError(region, ["configuration"]);
  const setup = resolveProbeSetup(region, budgets);

  const { outcome, cleanupFailed } = await probeEgress(setup, budgets);
  const failures: FailureReason[] = [];
  let status: EgressHealthResult["status"] | "wrong_ip";
  if (outcome.kind === "observed" && outcome.ip === setup.expectedIp) {
    status = "healthy";
    try {
      await setup.redis.del(unavailableKey(region, slot));
    } catch {
      // Only a duplicate run in this same window can have left a marker.
      logger.warn("Egress health streak reset failed", { region });
    }
  } else if (outcome.kind === "observed") {
    status = "wrong_ip";
    failures.push("wrong_ip");
  } else {
    status = "unavailable";
    try {
      await setup.redis.set(unavailableKey(region, slot), "1", {
        nx: true,
        ex: STREAK_TTL_S,
      });
      if ((await setup.redis.exists(unavailableKey(region, slot - 1))) > 0)
        failures.push("unavailable");
    } catch {
      failures.push("state");
    }
  }
  if (cleanupFailed) failures.push("cleanup");

  const attributes = {
    region,
    status,
    stage: outcome.kind === "unavailable" ? outcome.stage : undefined,
    failures,
  };
  if (failures.length) {
    logger.error("Egress health check failed", attributes);
    throw new EgressHealthError(region, failures);
  }
  if (status === "unavailable")
    logger.warn("Egress health probe unavailable", attributes);
  else logger.info("Egress health check passed", attributes);
  return { region, status: status === "healthy" ? "healthy" : "unavailable" };
}

const monitorTask = <TId extends string>(id: TId, region: E2BCluster) =>
  schedules.task({
    id,
    // Production only, on the five-minute boundary with no window offset.
    cron: {
      pattern: "*/5 * * * *",
      window: "0m",
      environments: ["PRODUCTION"],
    },
    machine: { preset: "small-1x" },
    maxDuration: MAX_DURATION_S,
    retry: { maxAttempts: 1 },
    // One probe sandbox per region at a time, including manual test runs.
    queue: { name: id, concurrencyLimit: 1 },
    run: (payload) => runEgressHealthCheck(region, payload.timestamp),
  });

export const egressHealthUsTask = monitorTask("egress-health-us", "us");
export const egressHealthEuTask = monitorTask("egress-health-eu", "eu");
