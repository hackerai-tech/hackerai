import {
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { api } from "@/convex/_generated/api";
import type { SandboxBootInfo } from "@/types";
import { getConvexClient, getConvexUrl } from "@/lib/db/convex-client";
import { CentrifugoSandbox } from "./centrifugo-sandbox";

const PROVIDER = "aws-lambda-microvm" as const;
const PLATFORM_MAX_DURATION_SECONDS = 8 * 60 * 60;
const DEFAULT_MAX_DURATION_SECONDS = 4 * 60 * 60;
const DEFAULT_MIN_REMAINING_SECONDS = 2 * 60 * 60 + 5 * 60;
const SESSION_READY_TIMEOUT_MS = 90_000;
const RELAY_READY_TIMEOUT_MS = 45_000;

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
  centrifugoWsUrl: string;
  centrifugoTokenSecret: string;
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
  const region =
    process.env.AWS_LAMBDA_MICROVM_REGION?.trim() ||
    process.env.AWS_REGION?.trim() ||
    "us-east-1";
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
    // The guest initiates its relay connection outbound. Keeping lifecycle
    // hooks behind NO_INGRESS prevents them from becoming a public control API.
    ingressConnectorArn: `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:NO_INGRESS`,
    egressConnectorArn:
      process.env.AWS_LAMBDA_MICROVM_EGRESS_CONNECTOR_ARN?.trim() ||
      `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
    maxDurationSeconds,
    minRemainingSeconds,
    logGroup:
      process.env.AWS_LAMBDA_MICROVM_LOG_GROUP?.trim() ||
      "/aws/lambda/microvms/hackerai-cloud-agent",
    serviceKey: required("CONVEX_SERVICE_ROLE_KEY"),
    centrifugoWsUrl: required("CENTRIFUGO_WS_URL"),
    centrifugoTokenSecret: required("CENTRIFUGO_TOKEN_SECRET"),
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
  if (/relay|centrifugo|presence|subscription/i.test(error.message)) {
    return "relay_not_ready";
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

async function waitForSessionConnection(
  userId: string,
  sessionId: string,
  config: AwsLambdaMicrovmConfig,
): Promise<CloudSession> {
  const deadline = Date.now() + SESSION_READY_TIMEOUT_MS;
  let pollDelayMs = 200;
  while (Date.now() < deadline) {
    const session = (await getConvexClient().query(
      api.localSandbox.getCloudSessionForBackend,
      {
        serviceKey: config.serviceKey,
        userId,
        sessionId,
      },
    )) as CloudSession | null;
    if (!session) throw new Error("Cloud sandbox session disappeared");
    if (session.status === "failed" || session.status === "terminated") {
      throw new Error(`Cloud sandbox session ended: ${session.status}`);
    }
    if (
      session.status === "running" &&
      session.microvmId &&
      session.connectionId
    ) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
    pollDelayMs = Math.min(1_000, Math.round(pollDelayMs * 1.5));
  }
  throw new Error("Timed out waiting for the cloud sandbox guest relay");
}

function createRelaySandbox(
  userId: string,
  session: CloudSession,
  config: AwsLambdaMicrovmConfig,
): CentrifugoSandbox {
  if (!session.connectionId) {
    throw new Error("Cloud sandbox session has no relay connection");
  }
  return new CentrifugoSandbox(
    userId,
    {
      connectionId: session.connectionId,
      name: "AWS Lambda MicroVM",
      cloudProvider: PROVIDER,
      osInfo: {
        platform: "linux",
        arch: "arm64",
        release: "Kali Linux",
        hostname: session.microvmId ?? "lambda-microvm",
      },
      capabilities: { commands: true, pty: true },
    },
    {
      wsUrl: config.centrifugoWsUrl,
      tokenSecret: config.centrifugoTokenSecret,
    },
    "/home/user",
  );
}

async function waitForRelayReady(sandbox: CentrifugoSandbox): Promise<void> {
  const deadline = Date.now() + RELAY_READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await sandbox.commands.run("echo ready", {
        timeoutMs: 5_000,
        displayName: "",
      });
      if (result.exitCode === 0 && result.stdout.includes("ready")) return;
      lastError = new Error(`Guest readiness exited ${result.exitCode}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const detail = lastError instanceof Error ? lastError.message : "unknown";
  throw new Error(`Cloud sandbox relay did not become ready: ${detail}`);
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
    const sandbox = createRelaySandbox(userId, connected, config);
    if (!connected.relayReadyAt) {
      await waitForRelayReady(sandbox);
    }
    return { session: connected, sandbox };
  }
  try {
    let state = await getClient(config.region).send(
      new GetMicrovmCommand({ microvmIdentifier: session.microvmId }),
    );
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

    const connected = await waitForSessionConnection(
      userId,
      session.sessionId,
      config,
    );
    const sandbox = createRelaySandbox(userId, connected, config);
    await waitForRelayReady(sandbox);
    return { session: connected, sandbox };
  } catch (error) {
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
    idle_policy_enabled: false,
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
      if (code !== "relay_not_ready" || replacementAttempt >= 1) throw error;
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
      log("warn", "cloud_sandbox_relay_replacement", {
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

  if (!begin.bootstrapToken) {
    await markEnded(
      userId,
      begin.session.sessionId,
      config,
      "failed",
      "bootstrap_token_missing",
    );
    throw new Error("Cloud session bootstrap token was not returned");
  }

  let microvmId: string | undefined;
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
      idle_policy_enabled: false,
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
        logging: config.executionRoleArn
          ? { cloudWatch: { logGroup: config.logGroup } }
          : { disabled: {} },
        maximumDurationInSeconds: config.maxDurationSeconds,
        clientToken: begin.session.sessionId,
        runHookPayload: JSON.stringify({
          convexUrl,
          sessionId: begin.session.sessionId,
          bootstrapToken: begin.bootstrapToken,
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
    const attached = await getConvexClient().mutation(
      api.localSandbox.attachCloudMicrovm,
      {
        serviceKey: config.serviceKey,
        userId,
        sessionId: begin.session.sessionId,
        microvmId,
      },
    );
    if (!attached) {
      throw new Error("Cloud session ended before the MicroVM was attached");
    }

    failureStage = "wait_for_guest_connection";
    log("debug", "cloud_sandbox_guest_connection_wait_started", {
      user_id: userId,
      session_id: begin.session.sessionId,
      microvm_id: microvmId,
      region: config.region,
      timeout_ms: SESSION_READY_TIMEOUT_MS,
    });
    const connected = await waitForSessionConnection(
      userId,
      begin.session.sessionId,
      config,
    );
    const sandbox = createRelaySandbox(userId, connected, config);
    if (!connected.relayReadyAt) {
      failureStage = "wait_for_relay_ready";
      log("debug", "cloud_sandbox_relay_ready_wait_started", {
        user_id: userId,
        session_id: connected.sessionId,
        microvm_id: connected.microvmId,
        region: config.region,
        timeout_ms: RELAY_READY_TIMEOUT_MS,
        compatibility_fallback: true,
      });
      await waitForRelayReady(sandbox);
    }
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
    return sandbox;
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
    try {
      if (!session.microvmId) {
        await markEnded(
          userId,
          session.sessionId,
          { serviceKey },
          "terminated",
          "deleted_before_start",
        );
        alreadyGone++;
        continue;
      }

      const outcome = await terminateMicrovm(session.microvmId, session.region);
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
          microvm_id: session.microvmId,
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
        new Error(
          `Failed to terminate AWS Lambda MicroVM ${session.microvmId}`,
        ),
      );
    } catch (error) {
      failures.push(error);
      log("warn", "cloud_sandbox_delete_session_failed", {
        user_id: userId,
        session_id: session.sessionId,
        microvm_id: session.microvmId ?? null,
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
