import type { Redis } from "@upstash/redis";
import { createRedisClient } from "@/lib/rate-limit/redis";
import { phLogger } from "@/lib/posthog/server";
import {
  getCloudSandboxProvider,
  type CloudSandboxProvider,
} from "./cloud-sandbox-provider";

const CIRCUIT_KEY = "cloud-sandbox:provider-circuit:aws:v1";
const HALF_OPEN_LOCK_KEY = `${CIRCUIT_KEY}:half-open`;
const FAILURE_COUNTER_PREFIX = `${CIRCUIT_KEY}:failures`;
const CIRCUIT_STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const HALF_OPEN_LOCK_SECONDS = 2 * 60;
const FAILURE_WINDOW_SECONDS = 2 * 60;
const ACCOUNT_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
const TRANSIENT_RETRY_DELAY_MS = 15 * 60 * 1000;
const TRANSIENT_FAILURE_THRESHOLD = 3;

const ACCOUNT_FAILURE_NAMES = new Set([
  "AccessDeniedException",
  "AccountSuspendedException",
  "CredentialsProviderError",
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "InvalidSignatureException",
  "UnrecognizedClientException",
]);

const TRANSIENT_FAILURE_NAMES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "InternalServerException",
  "NetworkingError",
  "RequestTimeout",
  "ServiceQuotaExceededException",
  "ThrottlingException",
  "TimeoutError",
  "TooManyRequestsException",
]);

export type AwsCircuitFailureClass = "account_access" | "provider_unavailable";

export type CloudSandboxProviderSelectionReason =
  | "configured_e2b"
  | "primary_aws"
  | "circuit_open"
  | "circuit_half_open_probe"
  | "automatic_failover_unavailable"
  | "persisted_subagent";

export type CloudSandboxProviderSelection = {
  provider: CloudSandboxProvider;
  reason: CloudSandboxProviderSelectionReason;
  circuitFailureClass?: AwsCircuitFailureClass;
  circuitOpenedAt?: string;
  circuitRetryAt?: string;
};

type AwsCircuitState = {
  version: 1;
  state: "open";
  failureClass: AwsCircuitFailureClass;
  failureName: string;
  openedAt: string;
  retryAt: string;
};

type ErrorDetails = {
  name: string;
  message: string;
  httpStatusCode?: number;
  code?: string;
};

type CircuitDependencies = {
  redis?: Pick<
    Redis,
    "del" | "eval" | "expire" | "get" | "incr" | "set"
  > | null;
  now?: () => number;
  log?: (
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ) => void;
};

let circuitStoreUnavailableLogged = false;

const runtimeEnvironment = (): string =>
  process.env.TRIGGER_ENV ??
  process.env.VERCEL_ENV ??
  process.env.NODE_ENV ??
  "unknown";

const defaultLog: NonNullable<CircuitDependencies["log"]> = (
  level,
  event,
  fields,
) => {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    service: "cloud-sandbox-provider-circuit",
    environment: runtimeEnvironment(),
    request_id: null,
    ...fields,
  };
  const message = JSON.stringify(payload);
  if (level === "error") console.error(message);
  else if (level === "warn") console.warn(message);
  else console.info(message);
};

const getDependencies = (dependencies?: CircuitDependencies) => ({
  redis:
    dependencies && "redis" in dependencies
      ? dependencies.redis
      : createRedisClient(),
  now: dependencies?.now ?? Date.now,
  log: dependencies?.log ?? defaultLog,
});

const automaticFailoverEnabled = (): boolean =>
  process.env.CLOUD_SANDBOX_AUTO_FAILOVER_ENABLED?.trim().toLowerCase() !==
  "false";

const e2bFallbackConfigured = (): boolean =>
  Boolean(process.env.E2B_API_KEY?.trim());

export const isCloudSandboxAutomaticFailoverConfigured = (): boolean =>
  getCloudSandboxProvider() === "aws-lambda-microvm" &&
  automaticFailoverEnabled() &&
  e2bFallbackConfigured() &&
  Boolean(createRedisClient());

const toErrorDetails = (error: unknown): ErrorDetails | null => {
  if (!error || typeof error !== "object") return null;
  const record = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return {
    name:
      typeof record.name === "string" && record.name
        ? record.name
        : "UnknownError",
    message: typeof record.message === "string" ? record.message : "",
    code: typeof record.code === "string" ? record.code : undefined,
    httpStatusCode:
      typeof record.$metadata?.httpStatusCode === "number"
        ? record.$metadata.httpStatusCode
        : undefined,
  };
};

const errorChain = (error: unknown): ErrorDetails[] => {
  const details: ErrorDetails[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth++) {
    seen.add(current);
    const detail = toErrorDetails(current);
    if (detail) details.push(detail);
    current = current instanceof Error ? current.cause : undefined;
  }
  return details;
};

export function classifyAwsCircuitFailure(
  error: unknown,
): { failureClass: AwsCircuitFailureClass; failureName: string } | null {
  for (const detail of errorChain(error)) {
    const name = detail.code ?? detail.name;
    if (
      ACCOUNT_FAILURE_NAMES.has(detail.name) ||
      (detail.code ? ACCOUNT_FAILURE_NAMES.has(detail.code) : false) ||
      detail.httpStatusCode === 401 ||
      detail.httpStatusCode === 403 ||
      /account\s+(?:is\s+)?(?:blocked|closed|disabled|suspended)|account suspension/i.test(
        detail.message,
      )
    ) {
      return { failureClass: "account_access", failureName: name };
    }
  }

  for (const detail of errorChain(error)) {
    const name = detail.code ?? detail.name;
    if (
      TRANSIENT_FAILURE_NAMES.has(detail.name) ||
      (detail.code ? TRANSIENT_FAILURE_NAMES.has(detail.code) : false) ||
      detail.httpStatusCode === 429 ||
      (detail.httpStatusCode !== undefined && detail.httpStatusCode >= 500)
    ) {
      return { failureClass: "provider_unavailable", failureName: name };
    }
  }

  return null;
}

const parseCircuitState = (value: unknown): AwsCircuitState | null => {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const state = parsed as Partial<AwsCircuitState>;
  if (
    state.version !== 1 ||
    state.state !== "open" ||
    (state.failureClass !== "account_access" &&
      state.failureClass !== "provider_unavailable") ||
    typeof state.failureName !== "string" ||
    typeof state.openedAt !== "string" ||
    typeof state.retryAt !== "string"
  ) {
    return null;
  }
  return state as AwsCircuitState;
};

export async function resolveCloudSandboxProviderForRun(
  options: { requestId?: string } = {},
  dependencies?: CircuitDependencies,
): Promise<CloudSandboxProviderSelection> {
  const configured = getCloudSandboxProvider();
  if (configured === "e2b") {
    return { provider: "e2b", reason: "configured_e2b" };
  }

  if (!automaticFailoverEnabled() || !e2bFallbackConfigured()) {
    return {
      provider: "aws-lambda-microvm",
      reason: automaticFailoverEnabled()
        ? "automatic_failover_unavailable"
        : "primary_aws",
    };
  }

  const { redis, now, log } = getDependencies(dependencies);
  if (!redis) {
    if (!circuitStoreUnavailableLogged) {
      circuitStoreUnavailableLogged = true;
      log("error", "cloud_sandbox_provider_circuit_store_unavailable", {
        request_id: options.requestId ?? null,
        provider: "aws-lambda-microvm",
        fallback_provider: "e2b",
      });
    }
    return {
      provider: "aws-lambda-microvm",
      reason: "automatic_failover_unavailable",
    };
  }

  try {
    const state = parseCircuitState(await redis.get(CIRCUIT_KEY));
    if (!state) {
      return { provider: "aws-lambda-microvm", reason: "primary_aws" };
    }

    const nowMs = now();
    const retryAtMs = Date.parse(state.retryAt);
    if (!Number.isFinite(retryAtMs) || nowMs < retryAtMs) {
      return {
        provider: "e2b",
        reason: "circuit_open",
        circuitFailureClass: state.failureClass,
        circuitOpenedAt: state.openedAt,
        circuitRetryAt: state.retryAt,
      };
    }

    const probeClaimed = await redis.set(
      HALF_OPEN_LOCK_KEY,
      options.requestId ?? String(nowMs),
      { nx: true, ex: HALF_OPEN_LOCK_SECONDS },
    );
    if (probeClaimed) {
      log("info", "cloud_sandbox_provider_circuit_half_opened", {
        request_id: options.requestId ?? null,
        provider: "aws-lambda-microvm",
        fallback_provider: "e2b",
        failure_class: state.failureClass,
        circuit_opened_at: state.openedAt,
        circuit_retry_at: state.retryAt,
      });
      return {
        provider: "aws-lambda-microvm",
        reason: "circuit_half_open_probe",
        circuitFailureClass: state.failureClass,
        circuitOpenedAt: state.openedAt,
        circuitRetryAt: state.retryAt,
      };
    }

    return {
      provider: "e2b",
      reason: "circuit_open",
      circuitFailureClass: state.failureClass,
      circuitOpenedAt: state.openedAt,
      circuitRetryAt: state.retryAt,
    };
  } catch (error) {
    log("error", "cloud_sandbox_provider_circuit_read_failed", {
      request_id: options.requestId ?? null,
      provider: "aws-lambda-microvm",
      fallback_provider: "e2b",
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      provider: "aws-lambda-microvm",
      reason: "automatic_failover_unavailable",
    };
  }
}

export async function recordAwsSandboxAcquisitionFailure(
  error: unknown,
  options: {
    requestId?: string;
    source: "health_probe" | "sandbox_acquisition";
    halfOpenProbe?: boolean;
  },
  dependencies?: CircuitDependencies,
): Promise<{ opened: boolean; failureClass?: AwsCircuitFailureClass }> {
  if (!automaticFailoverEnabled() || !e2bFallbackConfigured()) {
    return { opened: false };
  }
  const classification = classifyAwsCircuitFailure(error);
  if (!classification) return { opened: false };
  if (
    options.source === "health_probe" &&
    classification.failureClass !== "account_access"
  ) {
    return { opened: false, failureClass: classification.failureClass };
  }

  const { redis, now, log } = getDependencies(dependencies);
  if (!redis)
    return { opened: false, failureClass: classification.failureClass };

  const counterKey = `${FAILURE_COUNTER_PREFIX}:${classification.failureClass}`;
  try {
    const failureCount = Number(await redis.incr(counterKey));
    await redis.expire(counterKey, FAILURE_WINDOW_SECONDS);
    const threshold =
      options.halfOpenProbe || classification.failureClass === "account_access"
        ? 1
        : TRANSIENT_FAILURE_THRESHOLD;
    if (failureCount < threshold) {
      return { opened: false, failureClass: classification.failureClass };
    }

    const nowMs = now();
    const retryDelayMs =
      classification.failureClass === "account_access"
        ? ACCOUNT_RETRY_DELAY_MS
        : TRANSIENT_RETRY_DELAY_MS;
    const state: AwsCircuitState = {
      version: 1,
      state: "open",
      failureClass: classification.failureClass,
      failureName: classification.failureName,
      openedAt: new Date(nowMs).toISOString(),
      retryAt: new Date(nowMs + retryDelayMs).toISOString(),
    };
    const newlyOpened = await redis.set(CIRCUIT_KEY, JSON.stringify(state), {
      nx: true,
      ex: CIRCUIT_STATE_TTL_SECONDS,
    });
    if (!newlyOpened) {
      await redis.set(CIRCUIT_KEY, JSON.stringify(state), {
        ex: CIRCUIT_STATE_TTL_SECONDS,
      });
    }
    await redis.del(HALF_OPEN_LOCK_KEY, counterKey);
    if (newlyOpened) {
      log("warn", "cloud_sandbox_provider_circuit_opened", {
        request_id: options.requestId ?? null,
        provider: "aws-lambda-microvm",
        fallback_provider: "e2b",
        source: options.source,
        failure_class: classification.failureClass,
        failure_name: classification.failureName,
        failure_count: failureCount,
        failure_threshold: threshold,
        circuit_opened_at: state.openedAt,
        circuit_retry_at: state.retryAt,
      });
      phLogger.error("AWS Cloud sandbox circuit opened", {
        event: "cloud_sandbox_provider_circuit_opened",
        request_id: options.requestId ?? null,
        provider: "aws-lambda-microvm",
        fallback_provider: "e2b",
        source: options.source,
        failure_class: classification.failureClass,
        failure_name: classification.failureName,
        circuit_retry_at: state.retryAt,
      });
    }
    return {
      opened: true,
      failureClass: classification.failureClass,
    };
  } catch (circuitError) {
    log("error", "cloud_sandbox_provider_circuit_write_failed", {
      request_id: options.requestId ?? null,
      provider: "aws-lambda-microvm",
      fallback_provider: "e2b",
      source: options.source,
      failure_class: classification.failureClass,
      error_name:
        circuitError instanceof Error ? circuitError.name : "UnknownError",
    });
    return { opened: false, failureClass: classification.failureClass };
  }
}

export async function recordAwsSandboxHalfOpenSuccess(
  options: { requestId?: string },
  dependencies?: CircuitDependencies,
): Promise<void> {
  await closeAwsSandboxCircuit(options, undefined, dependencies);
}

async function closeAwsSandboxCircuit(
  options: { requestId?: string },
  expectedFailureClass: AwsCircuitFailureClass | undefined,
  dependencies?: CircuitDependencies,
): Promise<void> {
  const { redis, log } = getDependencies(dependencies);
  if (!redis) return;
  try {
    const previousState = parseCircuitState(await redis.get(CIRCUIT_KEY));
    if (!previousState) return;
    if (
      expectedFailureClass &&
      previousState.failureClass !== expectedFailureClass
    ) {
      return;
    }
    const deleted = Number(
      await redis.eval(
        `
          if redis.call("GET", KEYS[1]) == ARGV[1] then
            redis.call("DEL", KEYS[1], KEYS[2], KEYS[3], KEYS[4])
            return 1
          end
          return 0
        `,
        [
          CIRCUIT_KEY,
          HALF_OPEN_LOCK_KEY,
          `${FAILURE_COUNTER_PREFIX}:account_access`,
          `${FAILURE_COUNTER_PREFIX}:provider_unavailable`,
        ],
        [JSON.stringify(previousState)],
      ),
    );
    if (deleted !== 1) return;
    log("info", "cloud_sandbox_provider_circuit_closed", {
      request_id: options.requestId ?? null,
      provider: "aws-lambda-microvm",
      fallback_provider: "e2b",
      previous_failure_class: previousState.failureClass,
      circuit_opened_at: previousState.openedAt,
    });
  } catch (error) {
    log("error", "cloud_sandbox_provider_circuit_close_failed", {
      request_id: options.requestId ?? null,
      provider: "aws-lambda-microvm",
      fallback_provider: "e2b",
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export async function recordAwsAccountHealthProbeSuccess(
  options: { requestId?: string },
  dependencies?: CircuitDependencies,
): Promise<void> {
  await closeAwsSandboxCircuit(options, "account_access", dependencies);
}

export const CLOUD_SANDBOX_PROVIDER_CIRCUIT_CONSTANTS = {
  circuitKey: CIRCUIT_KEY,
  halfOpenLockKey: HALF_OPEN_LOCK_KEY,
  failureCounterPrefix: FAILURE_COUNTER_PREFIX,
  transientFailureThreshold: TRANSIENT_FAILURE_THRESHOLD,
  accountRetryDelayMs: ACCOUNT_RETRY_DELAY_MS,
  transientRetryDelayMs: TRANSIENT_RETRY_DELAY_MS,
} as const;

export function resetCloudSandboxProviderCircuitStateForTests(): void {
  circuitStoreUnavailableLogged = false;
}
