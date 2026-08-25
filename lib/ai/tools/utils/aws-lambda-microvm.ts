import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  type RunMicrovmCommandInput,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { api } from "@/convex/_generated/api";
import type { SandboxBootInfo } from "@/types";
import { getConvexClient, getConvexUrl } from "@/lib/db/convex-client";
import { createConvexRealtimeClient } from "@/lib/db/convex-realtime-client";
import { CentrifugoSandbox } from "./centrifugo-sandbox";
import { AwsLambdaMicrovmDirectSandbox } from "./aws-lambda-microvm-direct-sandbox";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import {
  AWS_LAMBDA_MICROVM_DEFAULT_REGION,
  AWS_LAMBDA_MICROVM_REGIONS,
  AWS_LAMBDA_MICROVM_RELEASE_MANIFEST_ENV,
  type AwsLambdaMicrovmPlacement,
  type AwsLambdaMicrovmRegion,
  parseAwsLambdaMicrovmReleaseManifest,
  resolveAwsLambdaMicrovmFailoverRegion,
  resolveAwsLambdaMicrovmPlacement,
} from "./aws-lambda-microvm-release";
import {
  restoreAwsLambdaMicrovmWorkspace,
  snapshotAwsLambdaMicrovmWorkspace,
} from "./aws-lambda-microvm-workspace";

const PROVIDER = "aws-lambda-microvm" as const;
export const AWS_LAMBDA_MICROVM_REGION = AWS_LAMBDA_MICROVM_DEFAULT_REGION;
const PLATFORM_MAX_DURATION_SECONDS = 8 * 60 * 60;
const DEFAULT_MAX_DURATION_SECONDS = 8 * 60 * 60;
const DEFAULT_MIN_REMAINING_SECONDS = 2 * 60 * 60 + 5 * 60;
const DIRECT_IDLE_SECONDS = 5 * 60;
const DIRECT_SUSPENDED_SECONDS = 30 * 60;
const CONFIRMED_ORPHAN_STALE_MS = 15 * 60 * 1_000;
const CONFIRMED_ORPHAN_CLEANUP_LIMIT = 1;
const SESSION_READY_TIMEOUT_MS = 90_000;
const USER_DELETION_TERMINATION_CONFIRM_TIMEOUT_MS =
  process.env.NODE_ENV === "test" ? 1_000 : 15_000;
const RETRYABLE_TRANSPORT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "NetworkingError",
  "TimeoutError",
]);
const NON_FAILOVER_ERROR_NAMES = new Set([
  "AccessDeniedException",
  "CredentialsProviderError",
  "ExpiredTokenException",
  "InvalidParameterValueException",
  "InvalidSignatureException",
  "ResourceNotFoundException",
  "UnrecognizedClientException",
  "ValidationException",
]);

type CloudSession = {
  sessionId: string;
  status: "starting" | "active" | "running" | "failed" | "terminated";
  microvmId?: string;
  connectionId?: string;
  region: string;
  requestedRegion?: string;
  placementReason?: string;
  imageIdentifier: string;
  imageVersion?: string;
  egressConnectorArn?: string;
  egressIpv4Address?: string;
  failoverFromRegion?: string;
  failoverErrorName?: string;
  failoverStartedAt?: number;
  failoverCompletedAt?: number;
  failoverDurationMs?: number;
  failoverOutcome?: "succeeded" | "failed";
  createdAt: number;
  updatedAt: number;
  bootstrapExpiresAt: number;
  lastConnectedAt?: number;
  relayReadyAt?: number;
  awsState?: AwsMicrovmState;
  awsStateCheckedAt?: number;
  failureCode?: string;
};

type AwsMicrovmState =
  | "PENDING"
  | "RUNNING"
  | "SUSPENDING"
  | "SUSPENDED"
  | "TERMINATING"
  | "TERMINATED";

type CloudSessionReconciliationCandidate = {
  userId: string;
  session: CloudSession;
};

type CloudSessionOrphanCleanupEligibility = {
  eligible: boolean;
  reason:
    | "eligible"
    | "session_not_owned"
    | "session_not_active"
    | "recent_activity"
    | "active_parent_run"
    | "active_subagent";
  lastActivityAt?: number;
};

export type AwsLambdaMicrovmReconciliationSummary = {
  checked: number;
  running: number;
  suspended: number;
  terminal: number;
  failures: number;
  orphanCleanupChecked: number;
  orphanCleanupEligible: number;
  orphanCleanupSuspended: number;
  orphanCleanupTerminated: number;
  orphanCleanupProtected: number;
  orphanCleanupFailures: number;
};

type CloudSessionCleanupCandidate = {
  sessionId: string;
  microvmId?: string;
  region: string;
  failureCode: string;
};

type TerminationOutcome = "terminated" | "already_gone" | "failed";

export type AwsLambdaMicrovmSuspensionSummary = {
  total: number;
  suspended: number;
  alreadySuspended: number;
  terminated: number;
  alreadyGone: number;
  workspacesSaved: number;
  ownershipProtected: number;
};

type AwsLambdaMicrovmConfig = {
  region: AwsLambdaMicrovmRegion;
  requestedRegion: AwsLambdaMicrovmRegion;
  triggerRegion: TriggerRunRegion;
  placementReason:
    | AwsLambdaMicrovmPlacement["reason"]
    | "legacy_us_east"
    | "regional_capacity_failover";
  releaseId?: string;
  imageIdentifier: string;
  imageVersion?: string;
  executionRoleArn?: string;
  ingressConnectorArn: string;
  egressConnectorArn: string;
  egressIpv4Address?: string;
  maxDurationSeconds: number;
  minRemainingSeconds: number;
  logGroup: string;
  serviceKey: string;
};

type RegionFailoverAttempt = {
  fromRegion: AwsLambdaMicrovmRegion;
  toRegion: AwsLambdaMicrovmRegion;
  initialSessionId: string;
  initialErrorName: string;
  initialFailureCode: string;
  startedAtMs: number;
};

type ConnectionAttemptContext = {
  acquisitionStartedAt: number;
  failover?: RegionFailoverAttempt;
};

const clients = new Map<string, LambdaMicrovmsClient>();

type LogLevel = "debug" | "info" | "warn" | "error";

function runtimeEnvironment(): string {
  return (
    process.env.TRIGGER_ENV ??
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV ??
    "unknown"
  );
}

function developmentLoggingEnabled(): boolean {
  if (process.env.AWS_LAMBDA_MICROVM_DEBUG === "true") return true;
  return runtimeEnvironment() !== "production";
}

function credentialSource(): string {
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SECRET_ACCESS_KEY) {
    return "environment";
  }
  if (process.env.AWS_WEB_IDENTITY_TOKEN_FILE) return "web_identity";
  if (
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  ) {
    return "container";
  }
  if (process.env.AWS_PROFILE) return "profile";
  return "default_chain";
}

function endpointKind(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "::1"
    ) {
      return "local";
    }
    return url.protocol === "https:" ? "remote_https" : "remote_other";
  } catch {
    return "invalid";
  }
}

function redactErrorMessage(
  message: string,
  additionalSecrets: Array<string | undefined> = [],
): string {
  let redacted = message.slice(0, 1_000);
  const knownSecrets = [
    process.env.AWS_SECRET_ACCESS_KEY,
    process.env.AWS_SESSION_TOKEN,
    process.env.CONVEX_SERVICE_ROLE_KEY,
    process.env.CENTRIFUGO_TOKEN_SECRET,
    ...additionalSecrets,
  ].filter((value): value is string => Boolean(value && value.length >= 4));

  for (const secret of knownSecrets) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }

  return redacted.replace(
    /((?:bootstrap[_-]?token|token|secret|password|access[_-]?key)\s*[:=]\s*)[^\s,}]+/gi,
    "$1[REDACTED]",
  );
}

function errorLogFields(
  error: unknown,
  additionalSecrets: Array<string | undefined> = [],
): Record<string, unknown> {
  const record =
    error && typeof error === "object"
      ? (error as {
          name?: unknown;
          message?: unknown;
          $metadata?: {
            requestId?: unknown;
            httpStatusCode?: unknown;
            attempts?: unknown;
            totalRetryDelay?: unknown;
          };
        })
      : null;
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : null;

  return {
    error_name:
      error instanceof Error
        ? error.name
        : typeof record?.name === "string"
          ? record.name
          : typeof error,
    error_message: rawMessage
      ? redactErrorMessage(rawMessage, additionalSecrets)
      : null,
    aws_request_id:
      typeof record?.$metadata?.requestId === "string"
        ? record.$metadata.requestId
        : null,
    aws_http_status_code:
      typeof record?.$metadata?.httpStatusCode === "number"
        ? record.$metadata.httpStatusCode
        : null,
    aws_attempts:
      typeof record?.$metadata?.attempts === "number"
        ? record.$metadata.attempts
        : null,
    aws_retry_delay_ms:
      typeof record?.$metadata?.totalRetryDelay === "number"
        ? record.$metadata.totalRetryDelay
        : null,
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for AWS Lambda MicroVMs`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function getAwsLambdaMicrovmConfig(
  triggerRegion: TriggerRunRegion = "us-east-1",
): AwsLambdaMicrovmConfig {
  const rawManifest =
    process.env[AWS_LAMBDA_MICROVM_RELEASE_MANIFEST_ENV]?.trim();
  const manifest = rawManifest
    ? parseAwsLambdaMicrovmReleaseManifest(rawManifest)
    : undefined;
  const placement = manifest
    ? resolveAwsLambdaMicrovmPlacement(triggerRegion, manifest)
    : {
        triggerRegion,
        requestedRegion: AWS_LAMBDA_MICROVM_DEFAULT_REGION,
        region: AWS_LAMBDA_MICROVM_DEFAULT_REGION,
        reason: "legacy_us_east" as const,
      };
  const region = placement.region;
  const regionalRelease = manifest?.regions[region];
  const maxDurationSeconds = Math.min(
    PLATFORM_MAX_DURATION_SECONDS,
    positiveInt(
      "AWS_LAMBDA_MICROVM_MAX_DURATION_SECONDS",
      DEFAULT_MAX_DURATION_SECONDS,
    ),
  );
  const minRemainingSeconds = Math.min(
    maxDurationSeconds,
    positiveInt(
      "AWS_LAMBDA_MICROVM_MIN_REMAINING_SECONDS",
      DEFAULT_MIN_REMAINING_SECONDS,
    ),
  );
  return {
    region,
    requestedRegion: placement.requestedRegion,
    triggerRegion: placement.triggerRegion,
    placementReason: placement.reason,
    releaseId: manifest?.releaseId,
    imageIdentifier:
      regionalRelease?.imageIdentifier ??
      required("AWS_LAMBDA_MICROVM_IMAGE_ID"),
    imageVersion:
      regionalRelease?.imageVersion ??
      process.env.AWS_LAMBDA_MICROVM_IMAGE_VERSION?.trim() ??
      undefined,
    executionRoleArn:
      regionalRelease?.executionRoleArn ??
      process.env.AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN?.trim() ??
      undefined,
    ingressConnectorArn: `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
    egressConnectorArn:
      regionalRelease?.egressConnectorArn ??
      `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
    egressIpv4Address: regionalRelease?.egressIpv4Address,
    maxDurationSeconds,
    minRemainingSeconds,
    logGroup:
      process.env.AWS_LAMBDA_MICROVM_LOG_GROUP?.trim() ||
      "/aws/lambda/microvms/hackerai-cloud-agent",
    serviceKey: required("CONVEX_SERVICE_ROLE_KEY"),
  };
}

function getRegionalReleaseConfig(
  base: AwsLambdaMicrovmConfig,
  region: AwsLambdaMicrovmRegion,
): AwsLambdaMicrovmConfig {
  const rawManifest =
    process.env[AWS_LAMBDA_MICROVM_RELEASE_MANIFEST_ENV]?.trim();
  if (!rawManifest) {
    throw new Error(
      `${AWS_LAMBDA_MICROVM_RELEASE_MANIFEST_ENV} is required for regional failover`,
    );
  }
  const manifest = parseAwsLambdaMicrovmReleaseManifest(rawManifest);
  const release = manifest.regions[region];
  if (!release.enabledForNewPlacements) {
    throw new Error(`${region} is disabled for new AWS MicroVM placements`);
  }
  return {
    ...base,
    region,
    placementReason: "regional_capacity_failover",
    imageIdentifier: release.imageIdentifier,
    imageVersion: release.imageVersion,
    executionRoleArn: release.executionRoleArn,
    ingressConnectorArn: `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
    egressConnectorArn: release.egressConnectorArn,
    egressIpv4Address: release.egressIpv4Address,
  };
}

function getRegionalFailoverConfig(
  failed: AwsLambdaMicrovmConfig,
): AwsLambdaMicrovmConfig | undefined {
  const rawManifest =
    process.env[AWS_LAMBDA_MICROVM_RELEASE_MANIFEST_ENV]?.trim();
  if (!rawManifest) return undefined;
  const manifest = parseAwsLambdaMicrovmReleaseManifest(rawManifest);
  const region = resolveAwsLambdaMicrovmFailoverRegion(failed.region, manifest);
  return region ? getRegionalReleaseConfig(failed, region) : undefined;
}

function getClient(region: string): LambdaMicrovmsClient {
  const existing = clients.get(region);
  if (existing) return existing;
  const created = new LambdaMicrovmsClient({ region, maxAttempts: 4 });
  clients.set(region, created);
  return created;
}

function getConfigForPersistedSession(
  session: CloudSession,
  desired: AwsLambdaMicrovmConfig,
): AwsLambdaMicrovmConfig {
  if (
    !AWS_LAMBDA_MICROVM_REGIONS.includes(
      session.region as AwsLambdaMicrovmRegion,
    )
  ) {
    throw new Error(
      `Persisted AWS Lambda MicroVM region ${session.region} is not supported`,
    );
  }
  const region = session.region as AwsLambdaMicrovmRegion;
  const rawManifest =
    process.env[AWS_LAMBDA_MICROVM_RELEASE_MANIFEST_ENV]?.trim();
  const regionalRelease = rawManifest
    ? parseAwsLambdaMicrovmReleaseManifest(rawManifest).regions[region]
    : undefined;
  return {
    ...desired,
    region,
    imageIdentifier: session.imageIdentifier,
    imageVersion: session.imageVersion,
    executionRoleArn:
      regionalRelease?.executionRoleArn ?? desired.executionRoleArn,
    ingressConnectorArn: `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
    egressConnectorArn:
      session.egressConnectorArn ??
      `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
    egressIpv4Address: session.egressIpv4Address,
  };
}

function log(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown>,
): void {
  if (level === "debug" && !developmentLoggingEnabled()) return;
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    service: "cloud-sandbox-provider",
    environment: runtimeEnvironment(),
    request_id: process.env.VERCEL_REQUEST_ID ?? null,
    provider: PROVIDER,
    ...fields,
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else if (level === "debug") console.debug(payload);
  else console.info(payload);
}

function isAwsNotFound(error: unknown): boolean {
  if (error instanceof Error && error.name === "ResourceNotFoundException") {
    return true;
  }
  if (!error || typeof error !== "object") return false;
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } })
    .$metadata;
  return metadata?.httpStatusCode === 404;
}

function failureCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  if (error.name === "AccessDeniedException") return "access_denied";
  if (error.name === "ServiceQuotaExceededException") return "quota_exceeded";
  if (
    error.name === "ThrottlingException" ||
    error.name === "TooManyRequestsException"
  ) {
    return "throttled";
  }
  if (error.name === "ValidationException") return "invalid_configuration";
  if (isAwsNotFound(error)) return "microvm_not_found";
  if (/websocket|direct endpoint|auth token|endpoint/i.test(error.message)) {
    return "direct_endpoint_not_ready";
  }
  const status = (error as { $metadata?: { httpStatusCode?: unknown } })
    .$metadata?.httpStatusCode;
  if (
    error.name === "InternalServerException" ||
    (typeof status === "number" && status >= 500)
  ) {
    return "provider_unavailable";
  }
  return "provider_error";
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { name?: unknown }).name === "string"
  ) {
    return (error as { name: string }).name;
  }
  return typeof error;
}

function errorCauseOrSelf(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined
    ? error.cause
    : error;
}

function isRetryableTransportError(error: unknown): boolean {
  const record =
    error && typeof error === "object"
      ? (error as {
          name?: unknown;
          code?: unknown;
          $retryable?: unknown;
          $metadata?: { httpStatusCode?: unknown };
        })
      : undefined;
  if (record?.$metadata?.httpStatusCode !== undefined) return false;
  const name = errorName(error);
  if (NON_FAILOVER_ERROR_NAMES.has(name)) return false;
  const code = typeof record?.code === "string" ? record.code : name;
  return (
    Boolean(record?.$retryable) || RETRYABLE_TRANSPORT_ERROR_CODES.has(code)
  );
}

export function isRegionalFailoverEligibleError(
  error: unknown,
  failureStage: string,
): boolean {
  if (failureStage !== "run_microvm") return false;
  const record =
    error && typeof error === "object"
      ? (error as {
          name?: unknown;
          code?: unknown;
          $retryable?: unknown;
          $metadata?: { httpStatusCode?: unknown };
        })
      : undefined;
  const name = errorName(error);
  if (NON_FAILOVER_ERROR_NAMES.has(name)) return false;
  if (
    name === "ThrottlingException" ||
    name === "TooManyRequestsException" ||
    name === "ServiceQuotaExceededException"
  ) {
    return true;
  }
  const status = record?.$metadata?.httpStatusCode;
  if (typeof status === "number" && status >= 500 && status <= 599) {
    return true;
  }
  if (name === "InternalServerException") return true;

  return isRetryableTransportError(error);
}

async function markEnded(
  userId: string,
  sessionId: string,
  config: Pick<AwsLambdaMicrovmConfig, "serviceKey">,
  status: "failed" | "terminated",
  code?: string,
): Promise<boolean> {
  return Boolean(
    await getConvexClient().mutation(api.localSandbox.markCloudSessionEnded, {
      serviceKey: config.serviceKey,
      userId,
      sessionId,
      status,
      failureCode: code,
    }),
  );
}

async function markCleanupPending(
  userId: string,
  sessionId: string,
  config: Pick<AwsLambdaMicrovmConfig, "serviceKey">,
  code: string,
): Promise<void> {
  await getConvexClient().mutation(
    api.localSandbox.markCloudSessionCleanupPending,
    {
      serviceKey: config.serviceKey,
      userId,
      sessionId,
      failureCode: code,
    },
  );
}

async function markDirectReady(
  userId: string,
  sessionId: string,
  microvmId: string,
  config: Pick<AwsLambdaMicrovmConfig, "serviceKey">,
): Promise<void> {
  const ready = await getConvexClient().mutation(
    api.localSandbox.markCloudDirectReady,
    {
      serviceKey: config.serviceKey,
      userId,
      sessionId,
      microvmId,
    },
  );
  if (!ready) throw new Error("Cloud session ended before direct readiness");
}

async function recordCloudMicrovmState(
  userId: string,
  sessionId: string,
  microvmId: string,
  serviceKey: string,
  state: AwsMicrovmState,
  failureCodeValue?: string,
): Promise<boolean> {
  return Boolean(
    await getConvexClient().mutation(
      api.localSandbox.recordCloudMicrovmStateForBackend,
      {
        serviceKey,
        userId,
        sessionId,
        microvmId,
        state,
        failureCode: failureCodeValue,
      },
    ),
  );
}

/** Read the authoritative Convex ownership gate immediately before cleanup. */
async function getCloudSessionOrphanCleanupEligibility(args: {
  serviceKey: string;
  userId: string;
  sessionId: string;
  microvmId: string;
  staleBeforeMs: number;
}): Promise<CloudSessionOrphanCleanupEligibility> {
  return (await getConvexClient().query(
    api.localSandbox.getCloudSessionOrphanCleanupEligibility,
    args,
  )) as CloudSessionOrphanCleanupEligibility;
}

function asAwsMicrovmState(value: unknown): AwsMicrovmState | undefined {
  switch (value) {
    case "PENDING":
    case "RUNNING":
    case "SUSPENDING":
    case "SUSPENDED":
    case "TERMINATING":
    case "TERMINATED":
      return value;
    default:
      return undefined;
  }
}

async function terminateMicrovm(
  microvmId: string,
  region: string,
): Promise<TerminationOutcome> {
  try {
    await getClient(region).send(
      new TerminateMicrovmCommand({ microvmIdentifier: microvmId }),
    );
    return "terminated";
  } catch (error) {
    if (isAwsNotFound(error)) return "already_gone";
    log("warn", "cloud_sandbox_termination_failed", {
      microvm_id: microvmId,
      region,
      failure_code: failureCode(error),
      ...errorLogFields(error),
    });
    return "failed";
  }
}

async function confirmMicrovmTerminated(
  microvmId: string,
  region: string,
): Promise<void> {
  const deadline = Date.now() + USER_DELETION_TERMINATION_CONFIRM_TIMEOUT_MS;
  let delayMs = 250;
  let lastState = "unknown";
  const timeoutError = () =>
    new Error(
      `AWS MicroVM termination was not confirmed; last state was ${lastState}`,
    );

  while (true) {
    const requestBudgetMs = deadline - Date.now();
    if (requestBudgetMs <= 0) throw timeoutError();
    const abortController = new AbortController();
    const abortTimeout = setTimeout(
      () => abortController.abort(),
      requestBudgetMs,
    );
    try {
      const response = await getClient(region).send(
        new GetMicrovmCommand({ microvmIdentifier: microvmId }),
        { abortSignal: abortController.signal },
      );
      lastState = response.state ?? "unknown";
      if (response.state === "TERMINATED") return;
    } catch (error) {
      if (isAwsNotFound(error)) return;
      if (abortController.signal.aborted) throw timeoutError();
      throw error;
    } finally {
      clearTimeout(abortTimeout);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(delayMs, remainingMs)),
    );
    delayMs = Math.min(Math.round(delayMs * 1.5), 1_000);
  }
}

async function cleanupCloudSessionCandidate(
  userId: string,
  candidate: CloudSessionCleanupCandidate,
  serviceKey: string,
): Promise<boolean> {
  let microvmId = candidate.microvmId;
  if (!microvmId) {
    const resolved = await getConvexClient().mutation(
      api.localSandbox.resolveCloudSessionCleanupTarget,
      {
        serviceKey,
        userId,
        sessionId: candidate.sessionId,
      },
    );
    if (resolved.endedWithoutMicrovm) return true;
    microvmId = resolved.microvmId;
    if (!microvmId) return false;
    candidate.microvmId = microvmId;
  }

  const outcome = await terminateMicrovm(microvmId, candidate.region);
  if (outcome === "failed") {
    await markCleanupPending(
      userId,
      candidate.sessionId,
      { serviceKey },
      "termination_retry_required",
    );
    return false;
  }
  await markEnded(
    userId,
    candidate.sessionId,
    { serviceKey },
    "terminated",
    outcome === "already_gone" ? "microvm_not_found" : candidate.failureCode,
  );
  return true;
}

async function cleanupCloudSessionCandidates(
  userId: string,
  candidates: CloudSessionCleanupCandidate[],
  serviceKey: string,
): Promise<number> {
  const results = await Promise.allSettled(
    candidates.map((candidate) =>
      cleanupCloudSessionCandidate(userId, candidate, serviceKey),
    ),
  );
  let failures = 0;
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled" && result.value) continue;
    failures++;
    const candidate = candidates[index];
    log("warn", "cloud_sandbox_replacement_cleanup_deferred", {
      user_id: userId,
      session_id: candidate.sessionId,
      microvm_id: candidate.microvmId ?? null,
      region: candidate.region,
      failure_code: candidate.failureCode,
      ...(result.status === "rejected" ? errorLogFields(result.reason) : {}),
    });
    if (result.status === "rejected") {
      // If recording the retry marker itself failed, leave the original
      // active row untouched so a later acquisition can still discover it.
      continue;
    }
  }
  return failures;
}

type SessionConnectionWaiter = {
  promise: Promise<CloudSession>;
  armTimeout: () => void;
  dispose: () => Promise<void>;
};

function createSessionConnectionWaiter(
  userId: string,
  sessionId: string,
  config: AwsLambdaMicrovmConfig,
  armImmediately = true,
): SessionConnectionWaiter {
  const realtime = createConvexRealtimeClient();
  let unsubscribe: (() => void) | undefined;
  let subscriptionStopped = false;
  let timeout: NodeJS.Timeout | undefined;
  let timeoutArmed = false;
  let settled = false;
  let resolvePromise!: (session: CloudSession) => void;
  let rejectPromise!: (error: Error) => void;

  const promise = new Promise<CloudSession>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // Readiness can fail while AWS Run/attachment is still in flight. Mark the
  // deferred as observed immediately; callers still await the original promise
  // and receive its rejection once the durable attachment stage completes.
  void promise.catch(() => undefined);

  const finish = (result: CloudSession | Error): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    if (unsubscribe && !subscriptionStopped) {
      subscriptionStopped = true;
      unsubscribe();
    }
    if (result instanceof Error) rejectPromise(result);
    else resolvePromise(result);
  };

  const armTimeout = (): void => {
    if (settled || timeoutArmed) return;
    timeoutArmed = true;
    timeout = setTimeout(
      () =>
        finish(
          new Error("Timed out waiting for the cloud sandbox guest relay"),
        ),
      SESSION_READY_TIMEOUT_MS,
    );
  };
  if (armImmediately) armTimeout();

  const registeredUnsubscribe = realtime.onUpdate(
    api.localSandbox.getCloudSessionForBackend,
    {
      serviceKey: config.serviceKey,
      userId,
      sessionId,
    },
    (session) => {
      const current = session as CloudSession | null;
      if (!current) {
        finish(new Error("Cloud sandbox session disappeared"));
        return;
      }
      if (current.status === "failed" || current.status === "terminated") {
        finish(new Error(`Cloud sandbox session ended: ${current.status}`));
        return;
      }
      if (
        (current.status === "active" || current.status === "running") &&
        current.microvmId
      ) {
        finish(current);
      }
    },
    (error) => finish(error),
  );
  unsubscribe = registeredUnsubscribe;
  if (settled && !subscriptionStopped) {
    subscriptionStopped = true;
    registeredUnsubscribe();
  }

  return {
    promise,
    armTimeout,
    dispose: async () => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (unsubscribe && !subscriptionStopped) {
        subscriptionStopped = true;
        unsubscribe();
      }
      try {
        await realtime.close();
      } catch (error) {
        // Subscription teardown must not turn an otherwise successful launch
        // into a failure or mask the original AWS/Convex failure.
        log("warn", "cloud_sandbox_readiness_subscription_close_failed", {
          user_id: userId,
          session_id: sessionId,
          provider: PROVIDER,
          region: config.region,
          ...errorLogFields(error),
        });
      }
    },
  };
}

async function waitForSessionConnection(
  userId: string,
  sessionId: string,
  config: AwsLambdaMicrovmConfig,
): Promise<CloudSession> {
  const waiter = createSessionConnectionWaiter(userId, sessionId, config);
  try {
    return await waiter.promise;
  } finally {
    await waiter.dispose();
  }
}

function createDirectSandbox(
  userId: string,
  session: CloudSession,
  endpoint: string,
  config: AwsLambdaMicrovmConfig,
): AwsLambdaMicrovmDirectSandbox {
  if (!session.microvmId) throw new Error("Cloud session has no MicroVM ID");
  return new AwsLambdaMicrovmDirectSandbox({
    userId,
    sessionId: session.sessionId,
    microvmId: session.microvmId,
    endpoint,
    issueAuthToken: async () => {
      const response = await getClient(config.region).send(
        new CreateMicrovmAuthTokenCommand({
          microvmIdentifier: session.microvmId,
          expirationInMinutes: 60,
          allowedPorts: [{ port: 9000 }],
        }),
      );
      const token = response.authToken?.["X-aws-proxy-auth"];
      if (!token) throw new Error("AWS did not return a MicroVM auth token");
      return token;
    },
    log,
  });
}

async function waitForRunningEndpoint(
  microvmId: string,
  config: AwsLambdaMicrovmConfig,
): Promise<string> {
  const deadline = Date.now() + SESSION_READY_TIMEOUT_MS;
  let delayMs = 250;
  let lastState = "unknown";
  while (Date.now() < deadline) {
    const state = await getClient(config.region).send(
      new GetMicrovmCommand({ microvmIdentifier: microvmId }),
    );
    lastState = state.state ?? "unknown";
    if (state.state === "RUNNING" && state.endpoint) return state.endpoint;
    if (state.state === "TERMINATED" || state.state === "TERMINATING") {
      throw new Error(
        `AWS MicroVM terminated before its direct endpoint was ready (${state.stateReason ?? "unknown"})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(Math.round(delayMs * 1.5), 1_000);
  }
  throw new Error(
    `AWS MicroVM direct endpoint did not become ready; last state was ${lastState}`,
  );
}

async function ensureExistingMicrovm(
  userId: string,
  session: CloudSession,
  config: AwsLambdaMicrovmConfig,
): Promise<{ session: CloudSession; sandbox: CentrifugoSandbox } | null> {
  if (!session.microvmId) {
    const connected = await waitForSessionConnection(
      userId,
      session.sessionId,
      config,
    );
    return ensureExistingMicrovm(userId, connected, config);
  }
  let directSandbox: AwsLambdaMicrovmDirectSandbox | undefined;
  try {
    let state = await getClient(config.region).send(
      new GetMicrovmCommand({ microvmIdentifier: session.microvmId }),
    );
    if (
      !state.ingressNetworkConnectors?.some((connector) =>
        connector.endsWith(":ALL_INGRESS"),
      )
    ) {
      const outcome = await terminateMicrovm(session.microvmId, config.region);
      if (outcome === "failed") {
        await markCleanupPending(
          userId,
          session.sessionId,
          config,
          "legacy_ingress_cleanup_failed",
        );
        throw new Error("Legacy cloud sandbox could not be replaced safely");
      }
      await markEnded(
        userId,
        session.sessionId,
        config,
        "terminated",
        "direct_ingress_required",
      );
      return null;
    }
    if (state.state === "SUSPENDED") {
      await getClient(config.region).send(
        new ResumeMicrovmCommand({ microvmIdentifier: session.microvmId }),
      );
    } else if (state.state === "SUSPENDING") {
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        state = await getClient(config.region).send(
          new GetMicrovmCommand({ microvmIdentifier: session.microvmId }),
        );
        if (state.state === "SUSPENDED") {
          await getClient(config.region).send(
            new ResumeMicrovmCommand({
              microvmIdentifier: session.microvmId,
            }),
          );
          break;
        }
      }
      if (state.state === "SUSPENDING") {
        throw new Error(
          "Cloud sandbox remained SUSPENDING after the resume wait budget",
        );
      }
    } else if (state.state === "TERMINATED" || state.state === "TERMINATING") {
      await markEnded(
        userId,
        session.sessionId,
        config,
        "terminated",
        "microvm_ended",
      );
      return null;
    }

    const endpoint = await waitForRunningEndpoint(session.microvmId, config);
    directSandbox = createDirectSandbox(userId, session, endpoint, config);
    await directSandbox.ready();
    if (state.startedAt && state.maximumDurationInSeconds) {
      const remainingMs =
        state.startedAt.getTime() +
        state.maximumDurationInSeconds * 1_000 -
        Date.now();
      if (remainingMs < config.minRemainingSeconds * 1_000) {
        await snapshotAwsLambdaMicrovmWorkspace({
          userId,
          serviceKey: config.serviceKey,
          region: config.region,
          sandbox: directSandbox,
        });
        await directSandbox.close();
        directSandbox = undefined;
        const terminationOutcome = await terminateMicrovm(
          session.microvmId,
          config.region,
        );
        if (terminationOutcome === "failed") {
          await markCleanupPending(
            userId,
            session.sessionId,
            config,
            "termination_retry_required",
          );
          throw new Error(
            "Cloud sandbox is near its maximum duration and could not be replaced safely",
          );
        }
        await markEnded(
          userId,
          session.sessionId,
          config,
          "terminated",
          "remaining_duration_low",
        );
        log("info", "cloud_sandbox_expiring_replaced", {
          user_id: userId,
          session_id: session.sessionId,
          microvm_id: session.microvmId,
          region: config.region,
          remaining_seconds: Math.max(0, Math.floor(remainingMs / 1_000)),
          min_remaining_seconds: config.minRemainingSeconds,
          workspace_snapshotted: true,
        });
        return null;
      }
    }

    const restore = await restoreAwsLambdaMicrovmWorkspace({
      userId,
      serviceKey: config.serviceKey,
      region: config.region,
      sandbox: directSandbox,
    });
    log("info", "cloud_sandbox_workspace_ready", {
      user_id: userId,
      session_id: session.sessionId,
      microvm_id: session.microvmId,
      region: config.region,
      workspace_snapshot_available: restore.snapshotAvailable,
      workspace_checkpointing_enabled: true,
      sandbox_reused: true,
    });
    return { session, sandbox: directSandbox };
  } catch (error) {
    await directSandbox?.close().catch((closeError: unknown) => {
      log("warn", "cloud_sandbox_direct_cleanup_failed", {
        user_id: userId,
        session_id: session.sessionId,
        microvm_id: session.microvmId ?? null,
        region: config.region,
        failure_stage: "reuse_connection_cleanup",
        ...errorLogFields(closeError),
      });
    });
    if (isAwsNotFound(error)) {
      await markEnded(
        userId,
        session.sessionId,
        config,
        "terminated",
        "microvm_not_found",
      );
      return null;
    }
    throw error;
  }
}

export async function ensureAwsLambdaMicrovmConnection(
  userId: string,
  onBoot?: (info: SandboxBootInfo) => void,
  triggerRegion: TriggerRunRegion = "us-east-1",
  triggerRunId?: string,
  replacementAttempt = 0,
  attemptContext?: ConnectionAttemptContext,
): Promise<CentrifugoSandbox> {
  const startedAt = attemptContext?.acquisitionStartedAt ?? performance.now();
  const currentAttempt: ConnectionAttemptContext = attemptContext ?? {
    acquisitionStartedAt: startedAt,
  };
  const correlation = { trigger_run_id: triggerRunId ?? null };
  let config: AwsLambdaMicrovmConfig;
  try {
    const requestedConfig = getAwsLambdaMicrovmConfig(triggerRegion);
    config = currentAttempt.failover
      ? getRegionalReleaseConfig(
          requestedConfig,
          currentAttempt.failover.toRegion,
        )
      : requestedConfig;
  } catch (error) {
    log("error", "cloud_sandbox_configuration_failed", {
      user_id: userId,
      ...correlation,
      replacement_attempt: replacementAttempt,
      failure_stage: "resolve_configuration",
      failure_code: failureCode(error),
      duration_ms: Math.round(performance.now() - startedAt),
      ...errorLogFields(error),
    });
    throw error;
  }

  const convexUrl = getConvexUrl();
  log("debug", "cloud_sandbox_configuration_resolved", {
    user_id: userId,
    ...correlation,
    trigger_region: config.triggerRegion,
    requested_region: config.requestedRegion,
    region: config.region,
    placement_reason: config.placementReason,
    release_id: config.releaseId ?? null,
    image_identifier: config.imageIdentifier,
    image_version: config.imageVersion ?? "latest",
    execution_role_configured: Boolean(config.executionRoleArn),
    ingress_connector: config.ingressConnectorArn.split(":").at(-1) ?? null,
    egress_connector: config.egressConnectorArn.split(":").at(-1) ?? null,
    max_duration_seconds: config.maxDurationSeconds,
    min_remaining_seconds: config.minRemainingSeconds,
    idle_policy_enabled: true,
    idle_seconds: DIRECT_IDLE_SECONDS,
    suspended_seconds: DIRECT_SUSPENDED_SECONDS,
    transport: "aws_websocket",
    log_group: config.logGroup,
    credential_source: credentialSource(),
    aws_profile: process.env.AWS_PROFILE?.trim() || null,
    convex_endpoint_kind: endpointKind(convexUrl),
    replacement_attempt: replacementAttempt,
    failover_attempt: Boolean(currentAttempt.failover),
    failover_from_region: currentAttempt.failover?.fromRegion ?? null,
  });

  let begin: {
    created: boolean;
    session: CloudSession;
    bootstrapToken?: string;
    cleanupCandidates: CloudSessionCleanupCandidate[];
  };
  try {
    begin = (await getConvexClient().mutation(
      api.localSandbox.beginCloudSession,
      {
        serviceKey: config.serviceKey,
        userId,
        region: config.region,
        requestedRegion: config.requestedRegion,
        placementReason: config.placementReason,
        imageIdentifier: config.imageIdentifier,
        imageVersion: config.imageVersion,
        egressConnectorArn: config.egressConnectorArn,
        egressIpv4Address: config.egressIpv4Address,
        ...(currentAttempt.failover
          ? {
              failoverFromRegion: currentAttempt.failover.fromRegion,
              failoverErrorName: currentAttempt.failover.initialErrorName,
              failoverStartedAt: currentAttempt.failover.startedAtMs,
            }
          : {}),
      },
    )) as typeof begin;
  } catch (error) {
    log("error", "cloud_sandbox_session_prepare_failed", {
      user_id: userId,
      ...correlation,
      region: config.region,
      image_version: config.imageVersion ?? "latest",
      replacement_attempt: replacementAttempt,
      failure_stage: "begin_cloud_session",
      failure_code: failureCode(error),
      duration_ms: Math.round(performance.now() - startedAt),
      ...errorLogFields(error),
    });
    throw error;
  }

  log("debug", "cloud_sandbox_session_prepared", {
    user_id: userId,
    ...correlation,
    session_id: begin.session.sessionId,
    microvm_id: begin.session.microvmId ?? null,
    region: config.region,
    image_version: config.imageVersion ?? "latest",
    session_status: begin.session.status,
    session_created: begin.created,
    replacement_attempt: replacementAttempt,
    cleanup_candidate_count: begin.cleanupCandidates.length,
    bootstrap_token_present: Boolean(begin.bootstrapToken),
    duration_ms: Math.round(performance.now() - startedAt),
  });

  const desiredConfig = config;
  config = getConfigForPersistedSession(begin.session, desiredConfig);
  if (
    !begin.created &&
    (config.region !== desiredConfig.region ||
      config.imageIdentifier !== desiredConfig.imageIdentifier ||
      config.imageVersion !== desiredConfig.imageVersion ||
      config.egressConnectorArn !== desiredConfig.egressConnectorArn)
  ) {
    log("info", "cloud_sandbox_sticky_session_retained", {
      user_id: userId,
      ...correlation,
      session_id: begin.session.sessionId,
      microvm_id: begin.session.microvmId ?? null,
      trigger_region: desiredConfig.triggerRegion,
      requested_region: desiredConfig.requestedRegion,
      selected_region: desiredConfig.region,
      persisted_region: config.region,
      requested_image_version: desiredConfig.imageVersion ?? "latest",
      persisted_image_version: config.imageVersion ?? "latest",
      requested_egress_connector:
        desiredConfig.egressConnectorArn.split(":").at(-1) ?? null,
      persisted_egress_connector:
        config.egressConnectorArn.split(":").at(-1) ?? null,
      persisted_egress_ipv4: config.egressIpv4Address ?? null,
      release_id: desiredConfig.releaseId ?? null,
    });
  }

  const cleanupFailureCount = await cleanupCloudSessionCandidates(
    userId,
    begin.cleanupCandidates,
    config.serviceKey,
  );
  if (cleanupFailureCount > 0 && begin.created) {
    await markEnded(
      userId,
      begin.session.sessionId,
      config,
      "failed",
      "replacement_cleanup_failed",
    );
    throw new Error(
      `Cloud sandbox replacement cleanup failed for ${cleanupFailureCount} session(s)`,
    );
  }

  if (!begin.created) {
    let existing: {
      session: CloudSession;
      sandbox: CentrifugoSandbox;
    } | null;
    try {
      existing = await ensureExistingMicrovm(userId, begin.session, config);
    } catch (error) {
      const code = failureCode(error);
      if (code !== "direct_endpoint_not_ready" || replacementAttempt >= 1) {
        throw error;
      }
      if (!begin.session.microvmId) throw error;
      const terminationOutcome = await terminateMicrovm(
        begin.session.microvmId,
        config.region,
      );
      if (terminationOutcome === "failed") {
        await markCleanupPending(
          userId,
          begin.session.sessionId,
          config,
          "termination_retry_required",
        );
        throw error;
      }
      await markEnded(userId, begin.session.sessionId, config, "failed", code);
      log("warn", "cloud_sandbox_direct_replacement", {
        user_id: userId,
        ...correlation,
        session_id: begin.session.sessionId,
        microvm_id: begin.session.microvmId ?? null,
        region: config.region,
        failure_code: code,
      });
      return ensureAwsLambdaMicrovmConnection(
        userId,
        onBoot,
        triggerRegion,
        triggerRunId,
        1,
        currentAttempt,
      );
    }
    if (!existing) {
      if (replacementAttempt >= 1) {
        throw new Error("Cloud sandbox could not be replaced");
      }
      return ensureAwsLambdaMicrovmConnection(
        userId,
        onBoot,
        triggerRegion,
        triggerRunId,
        1,
        currentAttempt,
      );
    }
    onBoot?.({
      path: "reuse_existing",
      duration_ms: Math.round(performance.now() - startedAt),
      create_attempts: 0,
      region: config.region,
      trigger_region: config.triggerRegion,
      requested_region: config.requestedRegion,
      placement_reason: config.placementReason,
      release_id: config.releaseId,
      image_version: existing.session.imageVersion ?? "latest",
      failover_from_region: currentAttempt.failover?.fromRegion,
      failover_error_name: currentAttempt.failover?.initialErrorName,
      failover_duration_ms: currentAttempt.failover
        ? Date.now() - currentAttempt.failover.startedAtMs
        : undefined,
    });
    log("info", "cloud_sandbox_reused", {
      user_id: userId,
      ...correlation,
      session_id: existing.session.sessionId,
      microvm_id: existing.session.microvmId,
      region: config.region,
      image_version: existing.session.imageVersion ?? "latest",
    });
    if (currentAttempt.failover) {
      log("info", "cloud_sandbox_region_failover_succeeded", {
        user_id: userId,
        ...correlation,
        initial_session_id: currentAttempt.failover.initialSessionId,
        session_id: existing.session.sessionId,
        requested_region: config.requestedRegion,
        failed_region: currentAttempt.failover.fromRegion,
        selected_region: config.region,
        initial_error_name: currentAttempt.failover.initialErrorName,
        initial_failure_code: currentAttempt.failover.initialFailureCode,
        failover_duration_ms: Date.now() - currentAttempt.failover.startedAtMs,
        outcome: "reused_concurrent_session",
      });
    }
    return existing.sandbox;
  }

  let microvmId: string | undefined;
  let directSandbox: AwsLambdaMicrovmDirectSandbox | undefined;
  let failureStage = "run_microvm";
  let runOutcomeReconciliationFailed = false;
  const runRequest: RunMicrovmCommandInput = {
    imageIdentifier: config.imageIdentifier,
    imageVersion: config.imageVersion,
    ...(config.executionRoleArn
      ? { executionRoleArn: config.executionRoleArn }
      : {}),
    ingressNetworkConnectors: [config.ingressConnectorArn],
    egressNetworkConnectors: [config.egressConnectorArn],
    idlePolicy: {
      maxIdleDurationSeconds: DIRECT_IDLE_SECONDS,
      suspendedDurationSeconds: DIRECT_SUSPENDED_SECONDS,
      autoResumeEnabled: true,
    },
    logging: config.executionRoleArn
      ? { cloudWatch: { logGroup: config.logGroup } }
      : { disabled: {} },
    maximumDurationInSeconds: config.maxDurationSeconds,
    clientToken: begin.session.sessionId,
    runHookPayload: JSON.stringify({
      sessionId: begin.session.sessionId,
      connectionName: "AWS Lambda MicroVM",
      ...(endpointKind(convexUrl) === "remote_https" && begin.bootstrapToken
        ? {
            lifecycleCallback: {
              convexUrl,
              bootstrapToken: begin.bootstrapToken,
            },
          }
        : {}),
    }),
  };
  try {
    const runStartedAt = performance.now();
    log("debug", "cloud_sandbox_run_requested", {
      user_id: userId,
      ...correlation,
      session_id: begin.session.sessionId,
      region: config.region,
      image_identifier: config.imageIdentifier,
      image_version: config.imageVersion ?? "latest",
      execution_role_configured: Boolean(config.executionRoleArn),
      ingress_connector: config.ingressConnectorArn.split(":").at(-1) ?? null,
      egress_connector: config.egressConnectorArn.split(":").at(-1) ?? null,
      max_duration_seconds: config.maxDurationSeconds,
      min_remaining_seconds: config.minRemainingSeconds,
      idle_policy_enabled: true,
      idle_seconds: DIRECT_IDLE_SECONDS,
      suspended_seconds: DIRECT_SUSPENDED_SECONDS,
      transport: "aws_websocket",
      convex_endpoint_kind: endpointKind(convexUrl),
    });
    let response;
    try {
      response = await getClient(config.region).send(
        new RunMicrovmCommand(runRequest),
      );
    } catch (runError) {
      if (!isRetryableTransportError(runError)) throw runError;
      log("warn", "cloud_sandbox_run_reconciliation_started", {
        user_id: userId,
        ...correlation,
        session_id: begin.session.sessionId,
        region: config.region,
        initial_error_name: errorName(runError),
        initial_failure_code: failureCode(runError),
      });
      try {
        // Replaying the identical idempotent request is the only safe way to
        // recover an AWS-created MicroVM when the first response was lost.
        response = await getClient(config.region).send(
          new RunMicrovmCommand(runRequest),
        );
      } catch (reconciliationError) {
        runOutcomeReconciliationFailed = true;
        log("warn", "cloud_sandbox_run_reconciliation_failed", {
          user_id: userId,
          ...correlation,
          session_id: begin.session.sessionId,
          region: config.region,
          initial_error_name: errorName(runError),
          reconciliation_error_name: errorName(reconciliationError),
          reconciliation_failure_code: failureCode(reconciliationError),
          ...errorLogFields(reconciliationError),
        });
        throw runError;
      }
      log("info", "cloud_sandbox_run_reconciliation_succeeded", {
        user_id: userId,
        ...correlation,
        session_id: begin.session.sessionId,
        microvm_id: response.microvmId ?? null,
        region: config.region,
        initial_error_name: errorName(runError),
        aws_request_id: response.$metadata.requestId ?? null,
        aws_http_status_code: response.$metadata.httpStatusCode ?? null,
      });
    }
    microvmId = response.microvmId;
    if (!microvmId) throw new Error("AWS did not return a MicroVM ID");
    log("info", "cloud_sandbox_run_accepted", {
      user_id: userId,
      ...correlation,
      session_id: begin.session.sessionId,
      microvm_id: microvmId,
      region: config.region,
      image_version: config.imageVersion ?? "latest",
      aws_request_id: response.$metadata.requestId ?? null,
      aws_http_status_code: response.$metadata.httpStatusCode ?? null,
      duration_ms: Math.round(performance.now() - runStartedAt),
    });

    failureStage = "attach_cloud_microvm";
    log("debug", "cloud_sandbox_direct_endpoint_wait_started", {
      user_id: userId,
      ...correlation,
      session_id: begin.session.sessionId,
      microvm_id: microvmId,
      region: config.region,
      timeout_ms: SESSION_READY_TIMEOUT_MS,
    });
    const attachPromise = getConvexClient()
      .mutation(api.localSandbox.attachCloudMicrovm, {
        serviceKey: config.serviceKey,
        userId,
        sessionId: begin.session.sessionId,
        microvmId,
      })
      .then((attached) => {
        if (!attached) {
          throw new Error(
            "Cloud session ended before the MicroVM was attached",
          );
        }
      });
    await attachPromise;
    failureStage = "wait_for_direct_endpoint";
    const endpoint =
      response.state === "RUNNING" && response.endpoint
        ? response.endpoint
        : await waitForRunningEndpoint(microvmId, config);
    const connected: CloudSession = { ...begin.session, microvmId };
    directSandbox = createDirectSandbox(userId, connected, endpoint, config);
    await directSandbox.ready();
    failureStage = "restore_workspace";
    const restore = await restoreAwsLambdaMicrovmWorkspace({
      userId,
      serviceKey: config.serviceKey,
      region: config.region,
      sandbox: directSandbox,
    });
    log("info", "cloud_sandbox_workspace_ready", {
      user_id: userId,
      ...correlation,
      session_id: connected.sessionId,
      microvm_id: connected.microvmId,
      region: config.region,
      workspace_snapshot_available: restore.snapshotAvailable,
      workspace_checkpointing_enabled: true,
      sandbox_reused: false,
    });
    failureStage = "mark_direct_ready";
    await markDirectReady(userId, connected.sessionId, microvmId, config);
    onBoot?.({
      path: "create_fresh",
      duration_ms: Math.round(performance.now() - startedAt),
      create_attempts: currentAttempt.failover ? 2 : 1,
      region: config.region,
      trigger_region: config.triggerRegion,
      requested_region: config.requestedRegion,
      placement_reason: config.placementReason,
      release_id: config.releaseId,
      image_version: connected.imageVersion ?? "latest",
      failover_from_region: currentAttempt.failover?.fromRegion,
      failover_error_name: currentAttempt.failover?.initialErrorName,
      failover_duration_ms: currentAttempt.failover
        ? Date.now() - currentAttempt.failover.startedAtMs
        : undefined,
    });
    log("info", "cloud_sandbox_created", {
      user_id: userId,
      ...correlation,
      session_id: connected.sessionId,
      microvm_id: connected.microvmId,
      region: config.region,
      image_version: connected.imageVersion ?? "latest",
      duration_ms: Math.round(performance.now() - startedAt),
    });
    if (currentAttempt.failover) {
      log("info", "cloud_sandbox_region_failover_succeeded", {
        user_id: userId,
        ...correlation,
        initial_session_id: currentAttempt.failover.initialSessionId,
        session_id: connected.sessionId,
        microvm_id: connected.microvmId,
        requested_region: config.requestedRegion,
        failed_region: currentAttempt.failover.fromRegion,
        selected_region: config.region,
        initial_error_name: currentAttempt.failover.initialErrorName,
        initial_failure_code: currentAttempt.failover.initialFailureCode,
        failover_duration_ms: Date.now() - currentAttempt.failover.startedAtMs,
        outcome: "created",
      });
    }
    return directSandbox;
  } catch (error) {
    const code = failureCode(error);
    const initialErrorName = errorName(error);
    const regionalFailoverErrorEligible =
      begin.created &&
      !currentAttempt.failover &&
      isRegionalFailoverEligibleError(error, failureStage);
    const regionalFailoverEligible =
      regionalFailoverErrorEligible && !runOutcomeReconciliationFailed;
    let failoverConfig: AwsLambdaMicrovmConfig | undefined;
    if (regionalFailoverEligible) {
      try {
        failoverConfig = getRegionalFailoverConfig(config);
      } catch (failoverConfigError) {
        log("warn", "cloud_sandbox_region_failover_configuration_failed", {
          user_id: userId,
          ...correlation,
          initial_session_id: begin.session.sessionId,
          requested_region: config.requestedRegion,
          failed_region: config.region,
          initial_error_name: initialErrorName,
          initial_failure_code: code,
          ...errorLogFields(failoverConfigError),
        });
      }
    }
    await directSandbox?.close().catch((closeError: unknown) => {
      log("warn", "cloud_sandbox_direct_cleanup_failed", {
        user_id: userId,
        ...correlation,
        session_id: begin.session.sessionId,
        microvm_id: microvmId ?? null,
        region: config.region,
        failure_stage: "creation_connection_cleanup",
        ...errorLogFields(closeError),
      });
    });
    let convexSessionClosed = false;
    let primaryCleanupConfirmed = false;
    if (microvmId) {
      const terminationOutcome = await terminateMicrovm(
        microvmId,
        config.region,
      );
      if (terminationOutcome === "failed") {
        await markCleanupPending(
          userId,
          begin.session.sessionId,
          config,
          "termination_retry_required",
        );
      } else {
        convexSessionClosed = await markEnded(
          userId,
          begin.session.sessionId,
          config,
          "failed",
          code,
        );
        primaryCleanupConfirmed = convexSessionClosed;
      }
    } else {
      convexSessionClosed = await markEnded(
        userId,
        begin.session.sessionId,
        config,
        "failed",
        code,
      );
      primaryCleanupConfirmed =
        convexSessionClosed && !runOutcomeReconciliationFailed;
    }

    const willFailOver = Boolean(failoverConfig && primaryCleanupConfirmed);
    log(willFailOver ? "warn" : "error", "cloud_sandbox_creation_failed", {
      user_id: userId,
      ...correlation,
      session_id: begin.session.sessionId,
      microvm_id: microvmId ?? null,
      region: config.region,
      requested_region: config.requestedRegion,
      image_identifier: config.imageIdentifier,
      image_version: config.imageVersion ?? "latest",
      execution_role_configured: Boolean(config.executionRoleArn),
      failure_stage: failureStage,
      failure_code: code,
      regional_failover_error_eligible: regionalFailoverErrorEligible,
      regional_failover_eligible: regionalFailoverEligible,
      run_outcome_reconciliation_failed: runOutcomeReconciliationFailed,
      regional_failover_available: Boolean(failoverConfig),
      regional_failover_selected_region: failoverConfig?.region ?? null,
      convex_session_closed: convexSessionClosed,
      primary_cleanup_confirmed: primaryCleanupConfirmed,
      credential_source: credentialSource(),
      aws_profile: process.env.AWS_PROFILE?.trim() || null,
      convex_endpoint_kind: endpointKind(convexUrl),
      duration_ms: Math.round(performance.now() - startedAt),
      ...errorLogFields(error, [begin.bootstrapToken]),
    });

    if (failoverConfig && primaryCleanupConfirmed) {
      const failover: RegionFailoverAttempt = {
        fromRegion: config.region,
        toRegion: failoverConfig.region,
        initialSessionId: begin.session.sessionId,
        initialErrorName,
        initialFailureCode: code,
        startedAtMs: Date.now(),
      };
      log("warn", "cloud_sandbox_region_failover_started", {
        user_id: userId,
        ...correlation,
        initial_session_id: failover.initialSessionId,
        requested_region: config.requestedRegion,
        failed_region: failover.fromRegion,
        selected_region: failover.toRegion,
        initial_error_name: failover.initialErrorName,
        initial_failure_code: failover.initialFailureCode,
        primary_cleanup_confirmed: true,
        acquisition_elapsed_ms: Math.round(performance.now() - startedAt),
        release_id: config.releaseId ?? null,
      });
      try {
        return await ensureAwsLambdaMicrovmConnection(
          userId,
          onBoot,
          triggerRegion,
          triggerRunId,
          replacementAttempt,
          {
            acquisitionStartedAt: currentAttempt.acquisitionStartedAt,
            failover,
          },
        );
      } catch (failoverError) {
        const fallbackCause = errorCauseOrSelf(failoverError);
        log("error", "cloud_sandbox_region_failover_failed", {
          user_id: userId,
          ...correlation,
          initial_session_id: failover.initialSessionId,
          requested_region: config.requestedRegion,
          failed_region: failover.fromRegion,
          selected_region: failover.toRegion,
          initial_error_name: failover.initialErrorName,
          initial_failure_code: failover.initialFailureCode,
          failover_duration_ms: Date.now() - failover.startedAtMs,
          outcome: "failed",
          fallback_error_name: errorName(fallbackCause),
          fallback_failure_code: failureCode(fallbackCause),
          ...errorLogFields(fallbackCause),
        });
        throw failoverError;
      }
    }
    throw new Error(`Failed creating AWS Lambda MicroVM sandbox (${code})`, {
      cause: error,
    });
  }
}

export async function terminateAwsLambdaMicrovmForUser(
  userId: string,
): Promise<{ total: number; killed: number; alreadyGone: number }> {
  const serviceKey = required("CONVEX_SERVICE_ROLE_KEY");
  const sessions = (await getConvexClient().query(
    api.localSandbox.listActiveCloudSessionsForBackend,
    {
      serviceKey,
      userId,
    },
  )) as CloudSession[];
  let killed = 0;
  let alreadyGone = 0;
  const failures: unknown[] = [];

  for (const session of sessions) {
    let microvmId = session.microvmId;
    try {
      if (!microvmId) {
        const resolved = await getConvexClient().mutation(
          api.localSandbox.resolveCloudSessionCleanupTarget,
          {
            serviceKey,
            userId,
            sessionId: session.sessionId,
          },
        );
        if (resolved.endedWithoutMicrovm) {
          alreadyGone++;
          continue;
        }
        microvmId = resolved.microvmId;
        if (!microvmId) {
          throw new Error(
            `Cloud session ${session.sessionId} has no resolvable MicroVM ID`,
          );
        }
      }

      const outcome = await terminateMicrovm(microvmId, session.region);
      if (outcome === "terminated") {
        // TerminateMicrovm acknowledges the request before AWS necessarily
        // stops the guest. Confirm the terminal state before the caller is
        // allowed to delete the workspace object that guest can checkpoint.
        try {
          await confirmMicrovmTerminated(microvmId, session.region);
        } catch (error) {
          await markCleanupPending(
            userId,
            session.sessionId,
            { serviceKey },
            "termination_confirmation_required",
          );
          throw error;
        }
        await markEnded(
          userId,
          session.sessionId,
          { serviceKey },
          "terminated",
        );
        killed++;
        log("info", "cloud_sandbox_deleted", {
          user_id: userId,
          session_id: session.sessionId,
          microvm_id: microvmId,
          region: session.region,
        });
        continue;
      }
      if (outcome === "already_gone") {
        await markEnded(
          userId,
          session.sessionId,
          { serviceKey },
          "terminated",
          "microvm_not_found",
        );
        alreadyGone++;
        continue;
      }

      await markCleanupPending(
        userId,
        session.sessionId,
        { serviceKey },
        "termination_retry_required",
      );
      failures.push(
        new Error(`Failed to terminate AWS Lambda MicroVM ${microvmId}`),
      );
    } catch (error) {
      failures.push(error);
      log("warn", "cloud_sandbox_delete_session_failed", {
        user_id: userId,
        session_id: session.sessionId,
        microvm_id: microvmId ?? null,
        region: session.region,
        failure_code: failureCode(error),
        ...errorLogFields(error),
      });
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to terminate ${failures.length} AWS Lambda MicroVM session(s)`,
    );
  }

  return { total: sessions.length, killed, alreadyGone };
}

/**
 * Stop compute for a user's reusable MicroVMs while retaining their state.
 *
 * The caller must first verify that no other Agent run is using the user's
 * shared sandbox. A failed suspend falls back to termination so an ended run
 * cannot leave a billable MicroVM running indefinitely.
 */
export async function suspendAwsLambdaMicrovmsForUser(
  userId: string,
  options: {
    sessionId?: string;
    orphanCleanup?: { microvmId: string; staleBeforeMs: number };
  } = {},
): Promise<AwsLambdaMicrovmSuspensionSummary> {
  const serviceKey = required("CONVEX_SERVICE_ROLE_KEY");
  const activeSessions = (await getConvexClient().query(
    api.localSandbox.listActiveCloudSessionsForBackend,
    {
      serviceKey,
      userId,
    },
  )) as CloudSession[];
  const sessions = options.sessionId
    ? activeSessions.filter(
        (session) => session.sessionId === options.sessionId,
      )
    : activeSessions;
  const summary: AwsLambdaMicrovmSuspensionSummary = {
    total: sessions.length,
    suspended: 0,
    alreadySuspended: 0,
    terminated: 0,
    alreadyGone: 0,
    workspacesSaved: 0,
    ownershipProtected: 0,
  };
  const failures: unknown[] = [];

  for (const session of sessions) {
    let microvmId = session.microvmId;
    if (!microvmId) {
      const resolved = await getConvexClient().mutation(
        api.localSandbox.resolveCloudSessionCleanupTarget,
        {
          serviceKey,
          userId,
          sessionId: session.sessionId,
        },
      );
      if (resolved.endedWithoutMicrovm) {
        summary.alreadyGone++;
        continue;
      }
      microvmId = resolved.microvmId;
      if (!microvmId) {
        failures.push(
          new Error(
            `Cloud session ${session.sessionId} has no resolvable MicroVM ID`,
          ),
        );
        continue;
      }
    }

    const startedAt = performance.now();
    let workspaceSaved = false;
    let directSandbox: AwsLambdaMicrovmDirectSandbox | undefined;
    try {
      const sessionConfig = getConfigForPersistedSession(
        session,
        getAwsLambdaMicrovmConfig(),
      );
      let current = await getClient(session.region).send(
        new GetMicrovmCommand({ microvmIdentifier: microvmId }),
      );
      if (current.state === "TERMINATED" || current.state === "TERMINATING") {
        await markEnded(
          userId,
          session.sessionId,
          { serviceKey },
          "terminated",
          "microvm_ended",
        );
        summary.alreadyGone++;
        continue;
      }

      const previousState = current.state;
      if (current.state === "SUSPENDING") {
        for (let attempt = 0; attempt < 20; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          current = await getClient(session.region).send(
            new GetMicrovmCommand({ microvmIdentifier: microvmId }),
          );
          if (current.state !== "SUSPENDING") break;
        }
      }
      if (current.state === "SUSPENDED") {
        // A suspended VM is not proof that S3 has a current archive: it may
        // predate workspace persistence or have been suspended after a failed
        // snapshot. Resume it once so cleanup cannot strand the only copy.
        await getClient(session.region).send(
          new ResumeMicrovmCommand({ microvmIdentifier: microvmId }),
        );
        const endpoint = await waitForRunningEndpoint(microvmId, sessionConfig);
        directSandbox = createDirectSandbox(
          userId,
          { ...session, microvmId },
          endpoint,
          sessionConfig,
        );
      } else if (current.state === "RUNNING") {
        const endpoint =
          current.endpoint ??
          (await waitForRunningEndpoint(microvmId, sessionConfig));
        directSandbox = createDirectSandbox(
          userId,
          { ...session, microvmId },
          endpoint,
          sessionConfig,
        );
      }
      if (current.state !== "RUNNING") {
        if (!directSandbox) {
          throw new Error(
            `MicroVM cannot be snapshotted from state ${current.state ?? "unknown"}`,
          );
        }
      }

      if (!directSandbox) {
        throw new Error("MicroVM workspace connection was not created");
      }
      await directSandbox.ready();
      await snapshotAwsLambdaMicrovmWorkspace({
        userId,
        serviceKey,
        region: sessionConfig.region,
        sandbox: directSandbox,
      });
      workspaceSaved = true;
      summary.workspacesSaved++;
      await directSandbox.close();
      directSandbox = undefined;
      log("info", "cloud_sandbox_workspace_saved", {
        user_id: userId,
        session_id: session.sessionId,
        microvm_id: microvmId,
        region: session.region,
        duration_ms: Math.round(performance.now() - startedAt),
      });

      if (options.orphanCleanup) {
        let eligibility: CloudSessionOrphanCleanupEligibility;
        try {
          eligibility = await getCloudSessionOrphanCleanupEligibility({
            serviceKey,
            userId,
            sessionId: session.sessionId,
            microvmId: options.orphanCleanup.microvmId,
            staleBeforeMs: options.orphanCleanup.staleBeforeMs,
          });
        } catch (error) {
          failures.push(error);
          log("warn", "cloud_sandbox_orphan_cleanup_recheck_failed", {
            user_id: userId,
            session_id: session.sessionId,
            microvm_id: microvmId,
            region: session.region,
            failure_code: failureCode(error),
            ...errorLogFields(error),
          });
          continue;
        }
        if (!eligibility.eligible) {
          summary.ownershipProtected++;
          log("info", "cloud_sandbox_orphan_cleanup_skipped", {
            user_id: userId,
            session_id: session.sessionId,
            microvm_id: microvmId,
            region: session.region,
            reason: eligibility.reason,
            phase: "post_snapshot",
          });
          continue;
        }
      }

      const response = await getClient(session.region).send(
        new SuspendMicrovmCommand({ microvmIdentifier: microvmId }),
      );
      await recordCloudMicrovmState(
        userId,
        session.sessionId,
        microvmId,
        serviceKey,
        "SUSPENDING",
      );
      if (previousState === "SUSPENDED") {
        summary.alreadySuspended++;
      } else {
        summary.suspended++;
      }
      log("info", "cloud_sandbox_suspend_accepted", {
        user_id: userId,
        session_id: session.sessionId,
        microvm_id: microvmId,
        region: session.region,
        previous_state: previousState,
        workspace_snapshotted: true,
        aws_request_id: response.$metadata.requestId ?? null,
        aws_http_status_code: response.$metadata.httpStatusCode ?? null,
        duration_ms: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      await directSandbox?.close().catch(() => undefined);
      if (isAwsNotFound(error)) {
        await markEnded(
          userId,
          session.sessionId,
          { serviceKey },
          "terminated",
          "microvm_not_found",
        );
        summary.alreadyGone++;
        continue;
      }

      log("warn", "cloud_sandbox_suspend_failed", {
        user_id: userId,
        session_id: session.sessionId,
        microvm_id: microvmId,
        region: session.region,
        failure_code: failureCode(error),
        workspace_snapshotted: workspaceSaved,
        duration_ms: Math.round(performance.now() - startedAt),
        ...errorLogFields(error),
      });
      if (!workspaceSaved) {
        // Suspending would put the only live copy on AWS's 30-minute automatic
        // termination path. Keep the session reusable and leave its existing
        // two-minute checkpoint loop running so transient S3 failures can heal.
        log("warn", "cloud_sandbox_unsaved_workspace_retained", {
          user_id: userId,
          session_id: session.sessionId,
          microvm_id: microvmId,
          region: session.region,
          reason: "snapshot_failed",
        });
        failures.push(error);
        continue;
      }
      const terminationOutcome = await terminateMicrovm(
        microvmId,
        session.region,
      );
      if (terminationOutcome === "terminated") {
        await markEnded(
          userId,
          session.sessionId,
          { serviceKey },
          "terminated",
          "suspend_failed_terminated",
        );
        summary.terminated++;
        log("warn", "cloud_sandbox_suspend_fallback_terminated", {
          user_id: userId,
          session_id: session.sessionId,
          microvm_id: microvmId,
          region: session.region,
        });
        continue;
      }
      if (terminationOutcome === "already_gone") {
        await markEnded(
          userId,
          session.sessionId,
          { serviceKey },
          "terminated",
          "microvm_not_found",
        );
        summary.alreadyGone++;
        continue;
      }

      await markCleanupPending(
        userId,
        session.sessionId,
        { serviceKey },
        "suspend_and_termination_failed",
      );
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to stop ${failures.length} AWS Lambda MicroVM session(s)`,
    );
  }

  return summary;
}

/**
 * Reconcile Convex's durable session index with AWS's authoritative physical
 * MicroVM state. Lifecycle callbacks normally keep rows current; this bounded
 * sweep repairs missed callbacks and platform-enforced terminations.
 */
export async function reconcileAwsLambdaMicrovmSessions(
  limit = 100,
): Promise<AwsLambdaMicrovmReconciliationSummary> {
  const serviceKey = required("CONVEX_SERVICE_ROLE_KEY");
  const candidates = (await getConvexClient().query(
    api.localSandbox.listCloudSessionsForReconciliation,
    { serviceKey, limit },
  )) as CloudSessionReconciliationCandidate[];
  const summary: AwsLambdaMicrovmReconciliationSummary = {
    checked: 0,
    running: 0,
    suspended: 0,
    terminal: 0,
    failures: 0,
    orphanCleanupChecked: 0,
    orphanCleanupEligible: 0,
    orphanCleanupSuspended: 0,
    orphanCleanupTerminated: 0,
    orphanCleanupProtected: 0,
    orphanCleanupFailures: 0,
  };
  const errors: unknown[] = [];
  const runningCandidates = new Map<
    string,
    CloudSessionReconciliationCandidate
  >();
  let orphanCleanupBudget = CONFIRMED_ORPHAN_CLEANUP_LIMIT;

  for (let offset = 0; offset < candidates.length; offset += 10) {
    const batch = candidates.slice(offset, offset + 10);
    await Promise.all(
      batch.map(async ({ userId, session }) => {
        if (!session.microvmId) return;
        try {
          const response = await getClient(session.region).send(
            new GetMicrovmCommand({
              microvmIdentifier: session.microvmId,
            }),
          );
          const state = asAwsMicrovmState(response.state);
          if (!state) {
            throw new Error(
              `AWS returned unknown MicroVM state ${String(response.state)}`,
            );
          }
          await recordCloudMicrovmState(
            userId,
            session.sessionId,
            session.microvmId,
            serviceKey,
            state,
            state === "TERMINATING" || state === "TERMINATED"
              ? "microvm_ended"
              : undefined,
          );
          summary.checked++;
          if (state === "RUNNING" || state === "PENDING") {
            summary.running++;
            if (state === "RUNNING" && !runningCandidates.has(userId)) {
              runningCandidates.set(userId, { userId, session });
            }
          } else if (state === "SUSPENDED" || state === "SUSPENDING") {
            summary.suspended++;
          } else summary.terminal++;
        } catch (error) {
          if (isAwsNotFound(error)) {
            try {
              await recordCloudMicrovmState(
                userId,
                session.sessionId,
                session.microvmId,
                serviceKey,
                "TERMINATED",
                "microvm_not_found",
              );
              summary.checked++;
              summary.terminal++;
              return;
            } catch (recordError) {
              error = recordError;
            }
          }
          summary.failures++;
          errors.push(error);
          log("warn", "cloud_sandbox_state_reconciliation_failed", {
            user_id: userId,
            session_id: session.sessionId,
            microvm_id: session.microvmId,
            region: session.region,
            failure_code: failureCode(error),
            ...errorLogFields(error),
          });
        }
      }),
    );
  }

  for (const { userId, session } of runningCandidates.values()) {
    if (!session.microvmId) continue;
    try {
      const staleBeforeMs = Date.now() - CONFIRMED_ORPHAN_STALE_MS;
      const eligibility = await getCloudSessionOrphanCleanupEligibility({
        serviceKey,
        userId,
        sessionId: session.sessionId,
        microvmId: session.microvmId,
        staleBeforeMs,
      });
      summary.orphanCleanupChecked++;
      if (!eligibility.eligible) {
        log("debug", "cloud_sandbox_orphan_cleanup_skipped", {
          user_id: userId,
          session_id: session.sessionId,
          microvm_id: session.microvmId,
          region: session.region,
          reason: eligibility.reason,
          last_activity_age_ms:
            eligibility.lastActivityAt === undefined
              ? null
              : Math.max(0, Date.now() - eligibility.lastActivityAt),
        });
        continue;
      }

      summary.orphanCleanupEligible++;
      orphanCleanupBudget--;
      const stopped = await suspendAwsLambdaMicrovmsForUser(userId, {
        sessionId: session.sessionId,
        orphanCleanup: { microvmId: session.microvmId, staleBeforeMs },
      });
      summary.orphanCleanupSuspended +=
        stopped.suspended + stopped.alreadySuspended;
      summary.orphanCleanupTerminated +=
        stopped.terminated + stopped.alreadyGone;
      summary.orphanCleanupProtected += stopped.ownershipProtected;
      log("info", "cloud_sandbox_confirmed_orphan_cleanup_completed", {
        user_id: userId,
        session_id: session.sessionId,
        microvm_id: session.microvmId,
        region: session.region,
        last_activity_age_ms:
          eligibility.lastActivityAt === undefined
            ? null
            : Math.max(0, Date.now() - eligibility.lastActivityAt),
        sessions_total: stopped.total,
        sessions_suspended: stopped.suspended + stopped.alreadySuspended,
        sessions_terminated: stopped.terminated + stopped.alreadyGone,
        sessions_ownership_protected: stopped.ownershipProtected,
        workspaces_saved: stopped.workspacesSaved,
      });
    } catch (error) {
      summary.orphanCleanupFailures++;
      errors.push(error);
      log("warn", "cloud_sandbox_confirmed_orphan_cleanup_failed", {
        user_id: userId,
        session_id: session.sessionId,
        microvm_id: session.microvmId,
        region: session.region,
        failure_code: failureCode(error),
        ...errorLogFields(error),
      });
    }
    if (orphanCleanupBudget <= 0) break;
  }

  log("info", "cloud_sandbox_state_reconciliation_completed", summary);
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `Failed to reconcile ${errors.length} AWS Lambda MicroVM session(s)`,
    );
  }
  return summary;
}
