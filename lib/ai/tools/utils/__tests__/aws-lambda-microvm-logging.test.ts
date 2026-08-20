const mockSend = jest.fn();
const mockDestroy = jest.fn();
const mockMutation = jest.fn();
const mockQuery = jest.fn();
const mockRelayRun = jest.fn();
const mockDirectReady = jest.fn();
const mockDirectClose = jest.fn();
const mockDirectConstructor = jest.fn();
const mockRealtimeClose = jest.fn().mockResolvedValue(undefined);
const mockRealtimeUnsubscribe = jest.fn();
const mockRealtimeOnUpdate = jest.fn(
  (
    query: unknown,
    args: unknown,
    callback: (value: unknown) => void,
    onError: (error: Error) => void,
  ) => {
    Promise.resolve(mockQuery(query, args)).then(callback, onError);
    return mockRealtimeUnsubscribe;
  },
);

jest.mock("@aws-sdk/client-lambda-microvms", () => {
  class Command {
    constructor(readonly input: unknown) {}
  }

  return {
    GetMicrovmCommand: Command,
    CreateMicrovmAuthTokenCommand: Command,
    ResumeMicrovmCommand: Command,
    RunMicrovmCommand: Command,
    SuspendMicrovmCommand: Command,
    TerminateMicrovmCommand: Command,
    LambdaMicrovmsClient: jest.fn().mockImplementation(() => ({
      send: mockSend,
      destroy: mockDestroy,
    })),
  };
});

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ mutation: mockMutation, query: mockQuery }),
  getConvexUrl: () => "http://127.0.0.1:3210",
}));

jest.mock("@/lib/db/convex-realtime-client", () => ({
  createConvexRealtimeClient: () => ({
    onUpdate: mockRealtimeOnUpdate,
    close: mockRealtimeClose,
  }),
}));

jest.mock("../centrifugo-sandbox", () => ({
  CentrifugoSandbox: jest.fn().mockImplementation(() => ({
    commands: { run: mockRelayRun },
  })),
}));

jest.mock("../aws-lambda-microvm-direct-sandbox", () => ({
  AwsLambdaMicrovmDirectSandbox: jest
    .fn()
    .mockImplementation((options: unknown) => {
      mockDirectConstructor(options);
      return {
        ready: mockDirectReady,
        close: mockDirectClose,
      };
    }),
}));

import {
  ensureAwsLambdaMicrovmConnection,
  getAwsLambdaMicrovmConfig,
  isRegionalFailoverEligibleError,
  suspendAwsLambdaMicrovmsForUser,
  terminateAwsLambdaMicrovmForUser,
} from "../aws-lambda-microvm";

function regionalReleaseManifest() {
  return JSON.stringify({
    schemaVersion: 1,
    releaseId: "regional-release",
    regions: Object.fromEntries(
      ["us-east-1", "us-west-2", "eu-west-1"].map((region) => [
        region,
        {
          imageIdentifier: `arn:aws:lambda:${region}:630609837323:microvm-image:hackerai-cloud-agent`,
          imageVersion: `${region}-version`,
          executionRoleArn: `arn:aws:iam::630609837323:role/${region}`,
          enabledForNewPlacements: true,
        },
      ]),
    ),
  });
}

describe("AWS Lambda MicroVM development logging", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtimeClose.mockResolvedValue(undefined);
    mockRealtimeOnUpdate.mockImplementation(
      (query, args, callback, onError) => {
        Promise.resolve(mockQuery(query, args)).then(callback, onError);
        return mockRealtimeUnsubscribe;
      },
    );
    mockRelayRun.mockResolvedValue({
      stdout: "ready\n",
      stderr: "",
      exitCode: 0,
    });
    mockDirectReady.mockResolvedValue(undefined);
    mockDirectClose.mockResolvedValue(undefined);
    process.env = {
      ...originalEnv,
      NODE_ENV: "development",
      AWS_PROFILE: "hackerai-microvm-admin",
      AWS_LAMBDA_MICROVM_IMAGE_ID:
        "arn:aws:lambda:us-east-1:630609837323:microvm-image:hackerai-cloud-agent",
      AWS_LAMBDA_MICROVM_IMAGE_VERSION: "6.0",
      AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN:
        "arn:aws:iam::630609837323:role/hackerai-microvm-execution",
      // Legacy tuning knobs remain ignored; endpoint lifecycle values are
      // intentionally fixed in code.
      AWS_LAMBDA_MICROVM_IDLE_SECONDS: "60",
      AWS_LAMBDA_MICROVM_SUSPENDED_SECONDS: "60",
      CONVEX_SERVICE_ROLE_KEY: "service-role-secret-value",
      CENTRIFUGO_WS_URL: "wss://relay.example.test/connection/websocket",
      CENTRIFUGO_TOKEN_SECRET: "centrifugo-secret-value",
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("connects through the authenticated AWS endpoint without Centrifugo readiness", async () => {
    const session = {
      sessionId: "session-direct",
      status: "starting" as const,
      region: "us-east-1",
      imageIdentifier: process.env.AWS_LAMBDA_MICROVM_IMAGE_ID,
      imageVersion: "6.0",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bootstrapExpiresAt: Date.now() + 60_000,
    };
    mockMutation
      .mockResolvedValueOnce({
        created: true,
        session,
        bootstrapToken: "legacy-bootstrap-unused",
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockSend.mockResolvedValueOnce({
      microvmId: "microvm-direct",
      state: "RUNNING",
      endpoint: "microvm-direct.lambda-microvm.us-east-1.on.aws",
      $metadata: { requestId: "run-direct", httpStatusCode: 200 },
    });
    const infoSpy = jest.spyOn(console, "info").mockImplementation();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation();

    await expect(
      ensureAwsLambdaMicrovmConnection("user-direct"),
    ).resolves.toBeDefined();

    expect(mockDirectReady).toHaveBeenCalledTimes(1);
    expect(mockRelayRun).not.toHaveBeenCalled();
    expect(mockRealtimeOnUpdate).not.toHaveBeenCalled();
    expect(mockDirectConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-direct",
        sessionId: "session-direct",
        microvmId: "microvm-direct",
        endpoint: "microvm-direct.lambda-microvm.us-east-1.on.aws",
      }),
    );
    mockSend.mockResolvedValueOnce({
      authToken: { "X-aws-proxy-auth": "short-lived-token" },
    });
    const directOptions = mockDirectConstructor.mock.calls[0][0] as {
      issueAuthToken: () => Promise<string>;
    };
    await expect(directOptions.issueAuthToken()).resolves.toBe(
      "short-lived-token",
    );
    expect(mockSend.mock.calls[1][0]).toMatchObject({
      input: {
        microvmIdentifier: "microvm-direct",
        expirationInMinutes: 60,
        allowedPorts: [{ port: 9000 }],
      },
    });
    const runInput = (mockSend.mock.calls[0][0] as { input: any }).input;
    expect(runInput).toMatchObject({
      ingressNetworkConnectors: [expect.stringContaining(":ALL_INGRESS")],
      idlePolicy: {
        maxIdleDurationSeconds: 300,
        suspendedDurationSeconds: 1800,
        autoResumeEnabled: true,
      },
    });
    const hookPayload = JSON.parse(runInput.runHookPayload);
    expect(hookPayload).toEqual({
      sessionId: "session-direct",
      connectionName: "AWS Lambda MicroVM",
    });
    infoSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("does not require Centrifugo configuration for the AWS provider", () => {
    delete process.env.CENTRIFUGO_WS_URL;
    delete process.env.CENTRIFUGO_TOKEN_SECRET;

    expect(getAwsLambdaMicrovmConfig()).toMatchObject({
      region: "us-east-1",
      ingressConnectorArn: expect.stringContaining(":ALL_INGRESS"),
    });
  });

  it("closes the direct client and terminates AWS when readiness fails", async () => {
    mockMutation
      .mockResolvedValueOnce({
        created: true,
        session: {
          sessionId: "session-readiness-failed",
          status: "starting",
          region: "us-east-1",
          imageIdentifier: process.env.AWS_LAMBDA_MICROVM_IMAGE_ID,
          imageVersion: "6.0",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          bootstrapExpiresAt: Date.now() + 60_000,
        },
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockSend
      .mockResolvedValueOnce({
        microvmId: "microvm-readiness-failed",
        state: "RUNNING",
        endpoint: "microvm-readiness-failed.example.test",
        $metadata: { requestId: "run-readiness-failed", httpStatusCode: 200 },
      })
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });
    mockDirectReady.mockRejectedValueOnce(
      new Error("AWS MicroVM direct WebSocket did not become ready"),
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation();
    const infoSpy = jest.spyOn(console, "info").mockImplementation();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation();

    await expect(
      ensureAwsLambdaMicrovmConnection("user-readiness-failed"),
    ).rejects.toThrow("direct_endpoint_not_ready");

    expect(mockDirectClose).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1][0]).toMatchObject({
      input: { microvmIdentifier: "microvm-readiness-failed" },
    });

    errorSpy.mockRestore();
    infoSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("logs the rejected AWS phase and metadata without exposing tokens", async () => {
    const bootstrapToken = "bootstrap-token-that-must-not-leak";
    mockMutation
      .mockResolvedValueOnce({
        created: true,
        session: {
          sessionId: "session-123",
          status: "starting",
          region: "us-east-1",
          imageIdentifier:
            "arn:aws:lambda:us-east-1:630609837323:microvm-image:hackerai-cloud-agent",
          imageVersion: "6.0",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          bootstrapExpiresAt: Date.now() + 60_000,
        },
        bootstrapToken,
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(undefined);

    const validationError = Object.assign(
      new Error(`Invalid runHookPayload token=${bootstrapToken}`),
      {
        name: "ValidationException",
        $metadata: {
          requestId: "aws-request-123",
          httpStatusCode: 400,
          attempts: 1,
          totalRetryDelay: 0,
        },
      },
    );
    mockSend.mockRejectedValueOnce(validationError);

    const errorSpy = jest.spyOn(console, "error").mockImplementation();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation();

    await expect(ensureAwsLambdaMicrovmConnection("user-123")).rejects.toThrow(
      "Failed creating AWS Lambda MicroVM sandbox (invalid_configuration)",
    );

    const errorPayload = JSON.parse(
      errorSpy.mock.calls.at(-1)?.[0] as string,
    ) as Record<string, unknown>;
    expect(errorPayload).toMatchObject({
      event: "cloud_sandbox_creation_failed",
      level: "error",
      user_id: "user-123",
      session_id: "session-123",
      failure_stage: "run_microvm",
      failure_code: "invalid_configuration",
      error_name: "ValidationException",
      aws_request_id: "aws-request-123",
      aws_http_status_code: 400,
      aws_attempts: 1,
      credential_source: "profile",
      convex_endpoint_kind: "local",
    });
    expect(errorPayload.error_message).toContain("[REDACTED]");
    expect(errorPayload.error_message).not.toContain(bootstrapToken);
    expect(mockRealtimeClose).not.toHaveBeenCalled();

    const runInput = (
      mockSend.mock.calls[0][0] as {
        input: Record<string, unknown>;
      }
    ).input;
    expect(runInput).toMatchObject({
      executionRoleArn:
        "arn:aws:iam::630609837323:role/hackerai-microvm-execution",
      logging: {
        cloudWatch: {
          logGroup: "/aws/lambda/microvms/hackerai-cloud-agent",
        },
      },
    });
    expect(runInput).toHaveProperty("idlePolicy");

    const debugEvents = debugSpy.mock.calls.map(
      ([payload]) => JSON.parse(payload as string).event,
    );
    expect(debugEvents).toEqual(
      expect.arrayContaining([
        "cloud_sandbox_configuration_resolved",
        "cloud_sandbox_session_prepared",
        "cloud_sandbox_run_requested",
      ]),
    );

    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("fails over one new session after a regional capacity error", async () => {
    process.env.AWS_LAMBDA_MICROVM_RELEASE_MANIFEST = regionalReleaseManifest();
    const now = Date.now();
    mockMutation
      .mockResolvedValueOnce({
        created: true,
        session: {
          sessionId: "session-east",
          status: "starting",
          region: "us-east-1",
          imageIdentifier:
            "arn:aws:lambda:us-east-1:630609837323:microvm-image:hackerai-cloud-agent",
          imageVersion: "us-east-1-version",
          createdAt: now,
          updatedAt: now,
          bootstrapExpiresAt: now + 60_000,
        },
        bootstrapToken: "bootstrap-east",
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({
        created: true,
        session: {
          sessionId: "session-west",
          status: "starting",
          region: "us-west-2",
          requestedRegion: "us-east-1",
          placementReason: "regional_capacity_failover",
          imageIdentifier:
            "arn:aws:lambda:us-west-2:630609837323:microvm-image:hackerai-cloud-agent",
          imageVersion: "us-west-2-version",
          failoverFromRegion: "us-east-1",
          failoverErrorName: "ThrottlingException",
          createdAt: now,
          updatedAt: now,
          bootstrapExpiresAt: now + 60_000,
        },
        bootstrapToken: "bootstrap-west",
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockSend
      .mockRejectedValueOnce(
        Object.assign(new Error("regional capacity exhausted"), {
          name: "ThrottlingException",
          $metadata: { httpStatusCode: 429 },
        }),
      )
      .mockResolvedValueOnce({
        microvmId: "microvm-west",
        state: "RUNNING",
        endpoint: "microvm-west.lambda-microvm.us-west-2.on.aws",
        $metadata: { requestId: "run-west", httpStatusCode: 200 },
      });
    const onBoot = jest.fn();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();
    const infoSpy = jest.spyOn(console, "info").mockImplementation();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation();

    await expect(
      ensureAwsLambdaMicrovmConnection(
        "user-failover",
        onBoot,
        "us-east-1",
        "trigger-run-failover",
      ),
    ).resolves.toBeDefined();

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0][0]).toMatchObject({
      input: {
        imageIdentifier: expect.stringContaining(":us-east-1:"),
      },
    });
    expect(mockSend.mock.calls[1][0]).toMatchObject({
      input: {
        imageIdentifier: expect.stringContaining(":us-west-2:"),
        imageVersion: "us-west-2-version",
      },
    });
    expect(mockMutation.mock.calls[2][1]).toMatchObject({
      userId: "user-failover",
      region: "us-west-2",
      requestedRegion: "us-east-1",
      placementReason: "regional_capacity_failover",
      failoverFromRegion: "us-east-1",
      failoverErrorName: "ThrottlingException",
      failoverStartedAt: expect.any(Number),
    });
    expect(onBoot).toHaveBeenCalledWith(
      expect.objectContaining({
        create_attempts: 2,
        region: "us-west-2",
        requested_region: "us-east-1",
        failover_from_region: "us-east-1",
        failover_error_name: "ThrottlingException",
        failover_duration_ms: expect.any(Number),
      }),
    );
    const warningEvents = warnSpy.mock.calls.map(
      ([payload]) => JSON.parse(payload as string).event,
    );
    expect(warningEvents).toContain("cloud_sandbox_region_failover_started");
    const successEvent = infoSpy.mock.calls
      .map(([payload]) => JSON.parse(payload as string))
      .find(
        (payload) =>
          payload.event === "cloud_sandbox_region_failover_succeeded",
      );
    expect(successEvent).toMatchObject({
      requested_region: "us-east-1",
      failed_region: "us-east-1",
      selected_region: "us-west-2",
      initial_error_name: "ThrottlingException",
      outcome: "created",
    });

    warnSpy.mockRestore();
    infoSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("makes at most one cross-region attempt", async () => {
    process.env.AWS_LAMBDA_MICROVM_RELEASE_MANIFEST = regionalReleaseManifest();
    const session = (sessionId: string, region: string) => ({
      sessionId,
      status: "starting" as const,
      region,
      imageIdentifier: `arn:aws:lambda:${region}:630609837323:microvm-image:hackerai-cloud-agent`,
      imageVersion: `${region}-version`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bootstrapExpiresAt: Date.now() + 60_000,
    });
    mockMutation
      .mockResolvedValueOnce({
        created: true,
        session: session("session-east-bounded", "us-east-1"),
        bootstrapToken: "bootstrap-east-bounded",
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({
        created: true,
        session: session("session-west-bounded", "us-west-2"),
        bootstrapToken: "bootstrap-west-bounded",
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(true);
    mockSend
      .mockRejectedValueOnce(
        Object.assign(new Error("east throttled"), {
          name: "TooManyRequestsException",
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("west quota exhausted"), {
          name: "ServiceQuotaExceededException",
        }),
      );
    const errorSpy = jest.spyOn(console, "error").mockImplementation();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation();

    await expect(
      ensureAwsLambdaMicrovmConnection("user-bounded-failover"),
    ).rejects.toThrow("quota_exceeded");

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockMutation).toHaveBeenCalledTimes(4);
    const failureEvent = errorSpy.mock.calls
      .map(([payload]) => JSON.parse(payload as string))
      .find(
        (payload) => payload.event === "cloud_sandbox_region_failover_failed",
      );
    expect(failureEvent).toMatchObject({
      failed_region: "us-east-1",
      selected_region: "us-west-2",
      initial_error_name: "TooManyRequestsException",
      outcome: "failed",
    });

    errorSpy.mockRestore();
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("does not fail over until the original session is durably closed", async () => {
    process.env.AWS_LAMBDA_MICROVM_RELEASE_MANIFEST = regionalReleaseManifest();
    mockMutation
      .mockResolvedValueOnce({
        created: true,
        session: {
          sessionId: "session-cleanup-unconfirmed",
          status: "starting",
          region: "us-east-1",
          imageIdentifier:
            "arn:aws:lambda:us-east-1:630609837323:microvm-image:hackerai-cloud-agent",
          imageVersion: "us-east-1-version",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          bootstrapExpiresAt: Date.now() + 60_000,
        },
        bootstrapToken: "bootstrap-cleanup-unconfirmed",
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(false);
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error("regional service unavailable"), {
        name: "InternalServerException",
        $metadata: { httpStatusCode: 503 },
      }),
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation();

    await expect(
      ensureAwsLambdaMicrovmConnection("user-cleanup-unconfirmed"),
    ).rejects.toThrow("provider_unavailable");

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockMutation).toHaveBeenCalledTimes(2);
    const failureEvent = JSON.parse(
      errorSpy.mock.calls.at(-1)?.[0] as string,
    ) as Record<string, unknown>;
    expect(failureEvent).toMatchObject({
      regional_failover_eligible: true,
      primary_cleanup_confirmed: false,
    });

    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("reconciles a lost RunMicrovm response with the same client token", async () => {
    process.env.AWS_LAMBDA_MICROVM_RELEASE_MANIFEST = regionalReleaseManifest();
    mockMutation
      .mockResolvedValueOnce({
        created: true,
        session: {
          sessionId: "session-transport-recovered",
          status: "starting",
          region: "us-east-1",
          imageIdentifier:
            "arn:aws:lambda:us-east-1:630609837323:microvm-image:hackerai-cloud-agent",
          imageVersion: "us-east-1-version",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          bootstrapExpiresAt: Date.now() + 60_000,
        },
        bootstrapToken: "bootstrap-transport-recovered",
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockSend
      .mockRejectedValueOnce(
        Object.assign(new Error("response timed out"), { code: "ETIMEDOUT" }),
      )
      .mockResolvedValueOnce({
        microvmId: "microvm-transport-recovered",
        state: "RUNNING",
        endpoint: "microvm-transport-recovered.example.test",
        $metadata: { requestId: "run-reconciled", httpStatusCode: 200 },
      });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();
    const infoSpy = jest.spyOn(console, "info").mockImplementation();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation();

    await expect(
      ensureAwsLambdaMicrovmConnection("user-transport-recovered"),
    ).resolves.toBeDefined();

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0][0]).toMatchObject({
      input: { clientToken: "session-transport-recovered" },
    });
    const initialRunInput = (mockSend.mock.calls[0][0] as { input: unknown })
      .input;
    const replayRunInput = (mockSend.mock.calls[1][0] as { input: unknown })
      .input;
    expect(replayRunInput).toEqual(initialRunInput);
    expect(mockMutation).toHaveBeenCalledTimes(3);
    const warningEvents = warnSpy.mock.calls.map(
      ([payload]) => JSON.parse(payload as string).event,
    );
    expect(warningEvents).toContain("cloud_sandbox_run_reconciliation_started");
    expect(warningEvents).not.toContain(
      "cloud_sandbox_region_failover_started",
    );
    const infoEvents = infoSpy.mock.calls.map(
      ([payload]) => JSON.parse(payload as string).event,
    );
    expect(infoEvents).toContain("cloud_sandbox_run_reconciliation_succeeded");

    warnSpy.mockRestore();
    infoSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("blocks failover when a lost RunMicrovm response cannot be reconciled", async () => {
    process.env.AWS_LAMBDA_MICROVM_RELEASE_MANIFEST = regionalReleaseManifest();
    mockMutation
      .mockResolvedValueOnce({
        created: true,
        session: {
          sessionId: "session-transport-unknown",
          status: "starting",
          region: "us-east-1",
          imageIdentifier:
            "arn:aws:lambda:us-east-1:630609837323:microvm-image:hackerai-cloud-agent",
          imageVersion: "us-east-1-version",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          bootstrapExpiresAt: Date.now() + 60_000,
        },
        bootstrapToken: "bootstrap-transport-unknown",
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(true);
    mockSend
      .mockRejectedValueOnce(
        Object.assign(new Error("response reset"), { code: "ECONNRESET" }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("reconciliation timed out"), {
          code: "ETIMEDOUT",
        }),
      );
    const errorSpy = jest.spyOn(console, "error").mockImplementation();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation();

    await expect(
      ensureAwsLambdaMicrovmConnection("user-transport-unknown"),
    ).rejects.toThrow("provider_error");

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockMutation).toHaveBeenCalledTimes(2);
    const warningEvents = warnSpy.mock.calls.map(
      ([payload]) => JSON.parse(payload as string).event,
    );
    expect(warningEvents).toContain("cloud_sandbox_run_reconciliation_failed");
    expect(warningEvents).not.toContain(
      "cloud_sandbox_region_failover_started",
    );
    const failureEvent = JSON.parse(
      errorSpy.mock.calls.at(-1)?.[0] as string,
    ) as Record<string, unknown>;
    expect(failureEvent).toMatchObject({
      regional_failover_error_eligible: true,
      regional_failover_eligible: false,
      run_outcome_reconciliation_failed: true,
      convex_session_closed: true,
      primary_cleanup_confirmed: false,
    });

    errorSpy.mockRestore();
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("classifies only RunMicrovm regional failures as failover eligible", () => {
    for (const error of [
      Object.assign(new Error("throttle"), { name: "ThrottlingException" }),
      Object.assign(new Error("quota"), {
        name: "ServiceQuotaExceededException",
      }),
      Object.assign(new Error("internal"), {
        name: "InternalServerException",
        $metadata: { httpStatusCode: 500 },
      }),
      Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
    ]) {
      expect(isRegionalFailoverEligibleError(error, "run_microvm")).toBe(true);
    }
    for (const name of [
      "AccessDeniedException",
      "InvalidSignatureException",
      "ValidationException",
    ]) {
      expect(
        isRegionalFailoverEligibleError(
          Object.assign(new Error(name), { name }),
          "run_microvm",
        ),
      ).toBe(false);
    }
    expect(
      isRegionalFailoverEligibleError(
        Object.assign(new Error("guest hook failed"), {
          name: "InternalServerException",
          $metadata: { httpStatusCode: 500 },
        }),
        "wait_for_direct_endpoint",
      ),
    ).toBe(false);
  });

  it("fails closed when a reused MicroVM never finishes suspending", async () => {
    jest.useFakeTimers();
    mockMutation.mockResolvedValueOnce({
      created: false,
      session: {
        sessionId: "session-stuck-suspending",
        status: "running",
        microvmId: "microvm-stuck-suspending",
        connectionId: "connection-stuck-suspending",
        region: "us-east-1",
        imageIdentifier: process.env.AWS_LAMBDA_MICROVM_IMAGE_ID,
        imageVersion: "6.0",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        bootstrapExpiresAt: Date.now() + 60_000,
      },
      cleanupCandidates: [],
    });
    mockSend.mockResolvedValue({
      state: "SUSPENDING",
      ingressNetworkConnectors: [
        "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS",
      ],
    });
    const pending = expect(
      ensureAwsLambdaMicrovmConnection("user-stuck-suspending"),
    ).rejects.toThrow("remained SUSPENDING");

    await jest.advanceTimersByTimeAsync(20_000);

    await pending;
    expect(mockSend).toHaveBeenCalledTimes(21);
  });

  it("keeps a session retryable when cleanup cannot terminate its MicroVM", async () => {
    mockMutation
      .mockResolvedValueOnce({
        created: true,
        session: {
          sessionId: "session-cleanup",
          status: "starting",
          region: "us-east-1",
          imageIdentifier: process.env.AWS_LAMBDA_MICROVM_IMAGE_ID,
          imageVersion: "6.0",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          bootstrapExpiresAt: Date.now() + 60_000,
        },
        bootstrapToken: "bootstrap-cleanup",
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mockSend
      .mockResolvedValueOnce({
        microvmId: "microvm-cleanup",
        $metadata: { requestId: "run-request", httpStatusCode: 200 },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("temporary AWS failure"), {
          name: "ServiceUnavailableException",
          $metadata: { httpStatusCode: 503 },
        }),
      );
    const errorSpy = jest.spyOn(console, "error").mockImplementation();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();
    const infoSpy = jest.spyOn(console, "info").mockImplementation();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation();

    await expect(
      ensureAwsLambdaMicrovmConnection("user-cleanup"),
    ).rejects.toThrow("Failed creating AWS Lambda MicroVM sandbox");

    expect(mockMutation).toHaveBeenCalledTimes(3);
    expect(mockMutation.mock.calls[2][1]).toMatchObject({
      userId: "user-cleanup",
      sessionId: "session-cleanup",
      failureCode: "termination_retry_required",
    });
    expect(mockRealtimeClose).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("attempts every user MicroVM termination before reporting failures", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        sessionId: "session-one",
        status: "running",
        microvmId: "microvm-one",
        region: "us-east-1",
      },
      {
        sessionId: "session-two",
        status: "running",
        microvmId: "microvm-two",
        region: "us-east-1",
      },
    ]);
    mockSend
      .mockRejectedValueOnce(
        Object.assign(new Error("denied"), { name: "AccessDeniedException" }),
      )
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });
    mockMutation.mockResolvedValue(true);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();
    const infoSpy = jest.spyOn(console, "info").mockImplementation();

    await expect(
      terminateAwsLambdaMicrovmForUser("user-delete"),
    ).rejects.toThrow("Failed to terminate 1 AWS Lambda MicroVM session");

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockMutation.mock.calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.anything(),
          expect.objectContaining({
            sessionId: "session-one",
            failureCode: "termination_retry_required",
          }),
        ]),
        expect.arrayContaining([
          expect.anything(),
          expect.objectContaining({ sessionId: "session-two" }),
        ]),
      ]),
    );

    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("resolves an attachment race before declaring a starting session gone", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        sessionId: "session-attachment-race",
        status: "starting",
        region: "us-east-1",
      },
    ]);
    mockMutation
      .mockResolvedValueOnce({
        endedWithoutMicrovm: false,
        microvmId: "microvm-attached-late",
      })
      .mockResolvedValueOnce(true);
    mockSend.mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });
    const infoSpy = jest.spyOn(console, "info").mockImplementation();

    await expect(
      terminateAwsLambdaMicrovmForUser("user-attachment-race"),
    ).resolves.toEqual({ total: 1, killed: 1, alreadyGone: 0 });

    expect(mockMutation.mock.calls[0][1]).toMatchObject({
      userId: "user-attachment-race",
      sessionId: "session-attachment-race",
    });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { microvmIdentifier: "microvm-attached-late" },
      }),
    );
    infoSpy.mockRestore();
  });

  it("suspends a running reusable MicroVM when the Agent becomes idle", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        sessionId: "session-suspend",
        status: "running",
        microvmId: "microvm-suspend",
        region: "us-east-1",
      },
    ]);
    mockSend.mockResolvedValueOnce({ state: "RUNNING" }).mockResolvedValueOnce({
      $metadata: { requestId: "suspend-request", httpStatusCode: 200 },
    });
    const infoSpy = jest.spyOn(console, "info").mockImplementation();

    await expect(suspendAwsLambdaMicrovmsForUser("user-idle")).resolves.toEqual(
      {
        total: 1,
        suspended: 1,
        alreadySuspended: 0,
        terminated: 0,
        alreadyGone: 0,
      },
    );

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1][0]).toMatchObject({
      input: { microvmIdentifier: "microvm-suspend" },
    });
    const event = infoSpy.mock.calls
      .map(([payload]) => JSON.parse(payload as string))
      .find((payload) => payload.event === "cloud_sandbox_suspend_accepted");
    expect(event).toMatchObject({
      user_id: "user-idle",
      session_id: "session-suspend",
      microvm_id: "microvm-suspend",
      aws_request_id: "suspend-request",
    });

    infoSpy.mockRestore();
  });

  it("terminates a MicroVM when suspension fails", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        sessionId: "session-suspend-fallback",
        status: "running",
        microvmId: "microvm-suspend-fallback",
        region: "us-east-1",
      },
    ]);
    mockSend
      .mockResolvedValueOnce({ state: "RUNNING" })
      .mockRejectedValueOnce(
        Object.assign(new Error("suspend unavailable"), {
          name: "ServiceUnavailableException",
        }),
      )
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });
    mockMutation.mockResolvedValueOnce(true);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    await expect(
      suspendAwsLambdaMicrovmsForUser("user-fallback"),
    ).resolves.toEqual({
      total: 1,
      suspended: 0,
      alreadySuspended: 0,
      terminated: 1,
      alreadyGone: 0,
    });
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(mockMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "session-suspend-fallback",
        status: "terminated",
        failureCode: "suspend_failed_terminated",
      }),
    );

    warnSpy.mockRestore();
  });

  it("keeps a session retryable when suspend and termination both fail", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        sessionId: "session-double-failure",
        status: "running",
        microvmId: "microvm-double-failure",
        region: "us-east-1",
      },
    ]);
    mockSend
      .mockResolvedValueOnce({ state: "RUNNING" })
      .mockRejectedValueOnce(new Error("suspend failed"))
      .mockRejectedValueOnce(new Error("terminate failed"));
    mockMutation.mockResolvedValueOnce(true);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    await expect(
      suspendAwsLambdaMicrovmsForUser("user-double-failure"),
    ).rejects.toThrow("Failed to stop 1 AWS Lambda MicroVM session");
    expect(mockMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "session-double-failure",
        failureCode: "suspend_and_termination_failed",
      }),
    );

    warnSpy.mockRestore();
  });

  it("uses a four-hour default but permits the eight-hour platform maximum", () => {
    const config = getAwsLambdaMicrovmConfig();
    expect(config).toMatchObject({
      maxDurationSeconds: 14_400,
      minRemainingSeconds: 7_500,
    });
    expect(config).not.toHaveProperty("idleSeconds");
    expect(config).not.toHaveProperty("suspendedSeconds");
    process.env.AWS_LAMBDA_MICROVM_MAX_DURATION_SECONDS = "28800";
    expect(getAwsLambdaMicrovmConfig().maxDurationSeconds).toBe(28_800);
  });

  it("keeps MicroVM execution in us-east-1 regardless of AWS region variables", () => {
    process.env.AWS_LAMBDA_MICROVM_REGION = "eu-west-1";
    process.env.AWS_REGION = "us-west-2";

    expect(getAwsLambdaMicrovmConfig().region).toBe("us-east-1");
  });

  it("selects the release entry paired with the Trigger execution region", () => {
    process.env.AWS_LAMBDA_MICROVM_RELEASE_MANIFEST = regionalReleaseManifest();

    expect(getAwsLambdaMicrovmConfig("eu-central-1")).toMatchObject({
      triggerRegion: "eu-central-1",
      requestedRegion: "eu-west-1",
      region: "eu-west-1",
      imageVersion: "eu-west-1-version",
      placementReason: "trigger_region_europe_pairing",
      releaseId: "regional-release",
    });
  });
});
