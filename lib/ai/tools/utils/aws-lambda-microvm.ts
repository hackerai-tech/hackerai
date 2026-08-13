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
const DEFAULT_MAX_DURATION_SECONDS = 8 * 60 * 60;
const DEFAULT_SUSPENDED_SECONDS = 30 * 60;
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
  failureCode?: string;
};

type AwsLambdaMicrovmConfig = {
  region: string;
  imageIdentifier: string;
  imageVersion?: string;
  ingressConnectorArn: string;
  egressConnectorArn: string;
  maxDurationSeconds: number;
  idleSeconds?: number;
  suspendedSeconds: number;
  logGroup: string;
  serviceKey: string;
  centrifugoWsUrl: string;
  centrifugoTokenSecret: string;
};

let client: LambdaMicrovmsClient | null = null;
let clientRegion: string | null = null;

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
    DEFAULT_MAX_DURATION_SECONDS,
    positiveInt(
      "AWS_LAMBDA_MICROVM_MAX_DURATION_SECONDS",
      DEFAULT_MAX_DURATION_SECONDS,
    ),
  );
  const idleSeconds = process.env.AWS_LAMBDA_MICROVM_IDLE_SECONDS
    ? Math.min(
        maxDurationSeconds,
        positiveInt("AWS_LAMBDA_MICROVM_IDLE_SECONDS", maxDurationSeconds),
      )
    : undefined;

  return {
    region,
    imageIdentifier: required("AWS_LAMBDA_MICROVM_IMAGE_ID"),
    imageVersion:
      process.env.AWS_LAMBDA_MICROVM_IMAGE_VERSION?.trim() || undefined,
    // The guest initiates its relay connection outbound. Keeping lifecycle
    // hooks behind NO_INGRESS prevents them from becoming a public control API.
    ingressConnectorArn: `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:NO_INGRESS`,
    egressConnectorArn:
      process.env.AWS_LAMBDA_MICROVM_EGRESS_CONNECTOR_ARN?.trim() ||
      `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
    maxDurationSeconds,
    idleSeconds,
    suspendedSeconds: positiveInt(
      "AWS_LAMBDA_MICROVM_SUSPENDED_SECONDS",
      DEFAULT_SUSPENDED_SECONDS,
    ),
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
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
): void {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    service: "cloud-sandbox-provider",
    environment:
      process.env.TRIGGER_ENV ??
      process.env.VERCEL_ENV ??
      process.env.NODE_ENV ??
      "unknown",
    request_id: process.env.VERCEL_REQUEST_ID ?? null,
    provider: PROVIDER,
    ...fields,
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
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

async function terminateBestEffort(
  microvmId: string | undefined,
  config: AwsLambdaMicrovmConfig,
): Promise<void> {
  if (!microvmId) return;
  try {
    await getClient(config.region).send(
      new TerminateMicrovmCommand({ microvmIdentifier: microvmId }),
    );
  } catch (error) {
    if (!isAwsNotFound(error)) {
      log("warn", "cloud_sandbox_termination_failed", {
        microvm_id: microvmId,
        failure_code: failureCode(error),
      });
    }
  }
}

async function waitForSessionConnection(
  userId: string,
  sessionId: string,
  config: AwsLambdaMicrovmConfig,
): Promise<CloudSession> {
  const deadline = Date.now() + SESSION_READY_TIMEOUT_MS;
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
    if (session.microvmId && session.connectionId) return session;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
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
    await waitForRelayReady(sandbox);
    return { session: connected, sandbox };
  }
  try {
    let state = await getClient(config.region).send(
      new GetMicrovmCommand({ microvmIdentifier: session.microvmId }),
    );
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
      await terminateBestEffort(session.microvmId, config);
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
  const config = getAwsLambdaMicrovmConfig();
  const startedAt = performance.now();
  const begin = (await getConvexClient().mutation(
    api.localSandbox.beginCloudSession,
    {
      serviceKey: config.serviceKey,
      userId,
      region: config.region,
      imageIdentifier: config.imageIdentifier,
      imageVersion: config.imageVersion,
    },
  )) as {
    created: boolean;
    session: CloudSession;
    bootstrapToken?: string;
    replacedMicrovmId?: string;
  };

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
      await terminateBestEffort(begin.session.microvmId, config);
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
    throw new Error("Cloud session bootstrap token was not returned");
  }

  await terminateBestEffort(begin.replacedMicrovmId, config);

  let microvmId: string | undefined;
  try {
    const response = await getClient(config.region).send(
      new RunMicrovmCommand({
        imageIdentifier: config.imageIdentifier,
        imageVersion: config.imageVersion,
        ingressNetworkConnectors: [config.ingressConnectorArn],
        egressNetworkConnectors: [config.egressConnectorArn],
        ...(config.idleSeconds
          ? {
              idlePolicy: {
                maxIdleDurationSeconds: config.idleSeconds,
                suspendedDurationSeconds: config.suspendedSeconds,
                autoResumeEnabled: false,
              },
            }
          : {}),
        logging: { cloudWatch: { logGroup: config.logGroup } },
        maximumDurationInSeconds: config.maxDurationSeconds,
        clientToken: begin.session.sessionId,
        runHookPayload: JSON.stringify({
          convexUrl: getConvexUrl(),
          sessionId: begin.session.sessionId,
          bootstrapToken: begin.bootstrapToken,
          connectionName: "AWS Lambda MicroVM",
        }),
      }),
    );
    microvmId = response.microvmId;
    if (!microvmId) throw new Error("AWS did not return a MicroVM ID");

    await getConvexClient().mutation(api.localSandbox.attachCloudMicrovm, {
      serviceKey: config.serviceKey,
      userId,
      sessionId: begin.session.sessionId,
      microvmId,
    });

    const connected = await waitForSessionConnection(
      userId,
      begin.session.sessionId,
      config,
    );
    const sandbox = createRelaySandbox(userId, connected, config);
    await waitForRelayReady(sandbox);
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
    await terminateBestEffort(microvmId, config);
    await markEnded(userId, begin.session.sessionId, config, "failed", code);
    log("error", "cloud_sandbox_creation_failed", {
      user_id: userId,
      session_id: begin.session.sessionId,
      microvm_id: microvmId ?? null,
      region: config.region,
      failure_code: code,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    throw new Error(`Failed creating AWS Lambda MicroVM sandbox (${code})`);
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

  for (const session of sessions) {
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

    try {
      await getClient(session.region).send(
        new TerminateMicrovmCommand({ microvmIdentifier: session.microvmId }),
      );
      await markEnded(userId, session.sessionId, { serviceKey }, "terminated");
      killed++;
      log("info", "cloud_sandbox_deleted", {
        user_id: userId,
        session_id: session.sessionId,
        microvm_id: session.microvmId,
        region: session.region,
      });
    } catch (error) {
      if (!isAwsNotFound(error)) throw error;
      await markEnded(
        userId,
        session.sessionId,
        { serviceKey },
        "terminated",
        "microvm_not_found",
      );
      alreadyGone++;
    }
  }

  return { total: sessions.length, killed, alreadyGone };
}
