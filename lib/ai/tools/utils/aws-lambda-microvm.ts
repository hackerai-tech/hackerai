import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { api } from "@/convex/_generated/api";
import type { SandboxBootInfo } from "@/types";
import { getConvexClient, getConvexUrl } from "@/lib/db/convex-client";
import { createConvexRealtimeClient } from "@/lib/db/convex-realtime-client";
import { CentrifugoSandbox } from "./centrifugo-sandbox";
import { AwsLambdaMicrovmDirectSandbox } from "./aws-lambda-microvm-direct-sandbox";

const PROVIDER = "aws-lambda-microvm" as const;
export const AWS_LAMBDA_MICROVM_REGION = "us-east-1" as const;
const PLATFORM_MAX_DURATION_SECONDS = 8 * 60 * 60;
const DEFAULT_MAX_DURATION_SECONDS = 4 * 60 * 60;
const DEFAULT_MIN_REMAINING_SECONDS = 2 * 60 * 60 + 5 * 60;
const DIRECT_IDLE_SECONDS = 5 * 60;
const DIRECT_SUSPENDED_SECONDS = 30 * 60;
const SESSION_READY_TIMEOUT_MS = 90_000;

type CloudSession = {
  sessionId: string;
  status: "starting" | "running" | "failed" | "terminated";
  microvmId?: string;
  connectionId?: string;
  region: string;
  imageIdentifier: string;
  imageVersion?: string;
  createdAt: number;
  updatedAt: number;
  bootstrapExpiresAt: number;
  relayReadyAt?: number;
  failureCode?: string;
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
};

type AwsLambdaMicrovmConfig = {
  region: string;
  imageIdentifier: string;
  imageVersion?: string;
  executionRoleArn?: string;
  ingressConnectorArn: string;
  egressConnectorArn: string;
  maxDurationSeconds: number;
  minRemainingSeconds: number;
  logGroup: string;
  serviceKey: string;
};

let client: LambdaMicrovmsClient | null = null;
let clientRegion: string | null = null;

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

export function getAwsLambdaMicrovmConfig(): AwsLambdaMicrovmConfig {
  const region = AWS_LAMBDA_MICROVM_REGION;
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
    imageIdentifier: required("AWS_LAMBDA_MICROVM_IMAGE_ID"),
    imageVersion:
      process.env.AWS_LAMBDA_MICROVM_IMAGE_VERSION?.trim() || undefined,
    executionRoleArn:
      process.env.AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN?.trim() || undefined,
    ingressConnectorArn: `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
    egressConnectorArn:
      process.env.AWS_LAMBDA_MICROVM_EGRESS_CONNECTOR_ARN?.trim() ||
      `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
    maxDurationSeconds,
    minRemainingSeconds,
    logGroup:
      process.env.AWS_LAMBDA_MICROVM_LOG_GROUP?.trim() ||
      "/aws/lambda/microvms/hackerai-cloud-agent",
    serviceKey: required("CONVEX_SERVICE_ROLE_KEY"),
  };
}

function getClient(region: string): LambdaMicrovmsClient {
  if (!client || clientRegion !== region) {
    client?.destroy();
    client = new LambdaMicrovmsClient({ region, maxAttempts: 4 });
    clientRegion = region;
  }
  return client;
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
  if (error.name === "ThrottlingException") return "throttled";
  if (error.name === "ValidationException") return "invalid_configuration";
  if (isAwsNotFound(error)) return "microvm_not_found";
  if (/websocket|direct endpoint|auth token|endpoint/i.test(error.message)) {
    return "direct_endpoint_not_ready";
  }
  return "provider_error";
}

async function markEnded(
  userId: string,
  sessionId: string,
  config: Pick<AwsLambdaMicrovmConfig, "serviceKey">,
  status: "failed" | "terminated",
  code?: string,
): Promise<void> {
  await getConvexClient().mutation(api.localSandbox.markCloudSessionEnded, {
    serviceKey: config.serviceKey,
    userId,
    sessionId,
    status,
    failureCode: code,
  });
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
        current.status === "running" &&
        current.microvmId &&
        current.connectionId
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
    if (state.startedAt && state.maximumDurationInSeconds) {
      const remainingMs =
        state.startedAt.getTime() +
        state.maximumDurationInSeconds * 1_000 -
        Date.now();
      if (remainingMs < config.minRemainingSeconds * 1_000) {
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
        });
        return null;
      }
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
  replacementAttempt = 0,
): Promise<CentrifugoSandbox> {
  const startedAt = performance.now();
  let config: AwsLambdaMicrovmConfig;
  try {
    config = getAwsLambdaMicrovmConfig();
  } catch (error) {
    log("error", "cloud_sandbox_configuration_failed", {
      user_id: userId,
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
    log_group: config.logGroup,
    credential_source: credentialSource(),
    aws_profile: process.env.AWS_PROFILE?.trim() || null,
    convex_endpoint_kind: endpointKind(convexUrl),
    replacement_attempt: replacementAttempt,
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
        imageIdentifier: config.imageIdentifier,
        imageVersion: config.imageVersion,
      },
    )) as typeof begin;
  } catch (error) {
    log("error", "cloud_sandbox_session_prepare_failed", {
      user_id: userId,
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
        session_id: begin.session.sessionId,
        microvm_id: begin.session.microvmId ?? null,
        region: config.region,
        failure_code: code,
      });
      return ensureAwsLambdaMicrovmConnection(userId, onBoot, 1);
    }
    if (!existing) {
      if (replacementAttempt >= 1) {
        throw new Error("Cloud sandbox could not be replaced");
      }
      return ensureAwsLambdaMicrovmConnection(userId, onBoot, 1);
    }
    onBoot?.({
      path: "reuse_existing",
      duration_ms: Math.round(performance.now() - startedAt),
      create_attempts: 0,
    });
    log("info", "cloud_sandbox_reused", {
      user_id: userId,
      session_id: existing.session.sessionId,
      microvm_id: existing.session.microvmId,
      region: config.region,
      image_version: existing.session.imageVersion ?? "latest",
    });
    return existing.sandbox;
  }

  let microvmId: string | undefined;
  let directSandbox: AwsLambdaMicrovmDirectSandbox | undefined;
  let failureStage = "run_microvm";
  try {
    const runStartedAt = performance.now();
    log("debug", "cloud_sandbox_run_requested", {
      user_id: userId,
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
    const response = await getClient(config.region).send(
      new RunMicrovmCommand({
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
        }),
      }),
    );
    microvmId = response.microvmId;
    if (!microvmId) throw new Error("AWS did not return a MicroVM ID");
    log("info", "cloud_sandbox_run_accepted", {
      user_id: userId,
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
    failureStage = "mark_direct_ready";
    await markDirectReady(userId, connected.sessionId, microvmId, config);
    onBoot?.({
      path: "create_fresh",
      duration_ms: Math.round(performance.now() - startedAt),
      create_attempts: 1,
    });
    log("info", "cloud_sandbox_created", {
      user_id: userId,
      session_id: connected.sessionId,
      microvm_id: connected.microvmId,
      region: config.region,
      image_version: connected.imageVersion ?? "latest",
      duration_ms: Math.round(performance.now() - startedAt),
    });
    return directSandbox;
  } catch (error) {
    const code = failureCode(error);
    log("error", "cloud_sandbox_creation_failed", {
      user_id: userId,
      session_id: begin.session.sessionId,
      microvm_id: microvmId ?? null,
      region: config.region,
      image_identifier: config.imageIdentifier,
      image_version: config.imageVersion ?? "latest",
      execution_role_configured: Boolean(config.executionRoleArn),
      failure_stage: failureStage,
      failure_code: code,
      credential_source: credentialSource(),
      aws_profile: process.env.AWS_PROFILE?.trim() || null,
      convex_endpoint_kind: endpointKind(convexUrl),
      duration_ms: Math.round(performance.now() - startedAt),
      ...errorLogFields(error, [begin.bootstrapToken]),
    });
    await directSandbox?.close().catch((closeError: unknown) => {
      log("warn", "cloud_sandbox_direct_cleanup_failed", {
        user_id: userId,
        session_id: begin.session.sessionId,
        microvm_id: microvmId ?? null,
        region: config.region,
        failure_stage: "creation_connection_cleanup",
        ...errorLogFields(closeError),
      });
    });
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
        await markEnded(
          userId,
          begin.session.sessionId,
          config,
          "failed",
          code,
        );
      }
    } else {
      await markEnded(userId, begin.session.sessionId, config, "failed", code);
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
): Promise<AwsLambdaMicrovmSuspensionSummary> {
  const serviceKey = required("CONVEX_SERVICE_ROLE_KEY");
  const sessions = (await getConvexClient().query(
    api.localSandbox.listActiveCloudSessionsForBackend,
    {
      serviceKey,
      userId,
    },
  )) as CloudSession[];
  const summary: AwsLambdaMicrovmSuspensionSummary = {
    total: sessions.length,
    suspended: 0,
    alreadySuspended: 0,
    terminated: 0,
    alreadyGone: 0,
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
    try {
      const current = await getClient(session.region).send(
        new GetMicrovmCommand({ microvmIdentifier: microvmId }),
      );
      if (current.state === "SUSPENDED" || current.state === "SUSPENDING") {
        summary.alreadySuspended++;
        log("info", "cloud_sandbox_suspend_skipped", {
          user_id: userId,
          session_id: session.sessionId,
          microvm_id: microvmId,
          region: session.region,
          microvm_state: current.state,
          reason: "already_suspended",
          duration_ms: Math.round(performance.now() - startedAt),
        });
        continue;
      }
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
      if (current.state !== "RUNNING") {
        throw new Error(
          `MicroVM cannot be suspended from state ${current.state ?? "unknown"}`,
        );
      }

      const response = await getClient(session.region).send(
        new SuspendMicrovmCommand({ microvmIdentifier: microvmId }),
      );
      summary.suspended++;
      log("info", "cloud_sandbox_suspend_accepted", {
        user_id: userId,
        session_id: session.sessionId,
        microvm_id: microvmId,
        region: session.region,
        previous_state: current.state,
        aws_request_id: response.$metadata.requestId ?? null,
        aws_http_status_code: response.$metadata.httpStatusCode ?? null,
        duration_ms: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
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
        duration_ms: Math.round(performance.now() - startedAt),
        ...errorLogFields(error),
      });
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
