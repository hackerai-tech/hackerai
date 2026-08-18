const mockSend = jest.fn();
const mockDestroy = jest.fn();
const mockMutation = jest.fn();
const mockQuery = jest.fn();
const mockRelayRun = jest.fn();
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
    ResumeMicrovmCommand: Command,
    RunMicrovmCommand: Command,
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

import {
  ensureAwsLambdaMicrovmConnection,
  getAwsLambdaMicrovmConfig,
  terminateAwsLambdaMicrovmForUser,
} from "../aws-lambda-microvm";

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
    process.env = {
      ...originalEnv,
      NODE_ENV: "development",
      AWS_PROFILE: "hackerai-microvm-admin",
      AWS_LAMBDA_MICROVM_IMAGE_ID:
        "arn:aws:lambda:us-east-1:630609837323:microvm-image:hackerai-cloud-agent",
      AWS_LAMBDA_MICROVM_IMAGE_VERSION: "6.0",
      AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN:
        "arn:aws:iam::630609837323:role/hackerai-microvm-execution",
      // These legacy knobs must remain ignored. HackerAI's relay is outbound,
      // so AWS endpoint-idle traffic is not a valid activity signal.
      AWS_LAMBDA_MICROVM_IDLE_SECONDS: "60",
      AWS_LAMBDA_MICROVM_SUSPENDED_SECONDS: "60",
      CONVEX_SERVICE_ROLE_KEY: "service-role-secret-value",
      CENTRIFUGO_WS_URL: "wss://relay.example.test/connection/websocket",
      CENTRIFUGO_TOKEN_SECRET: "centrifugo-secret-value",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("uses the guest relay-ready marker without an extra command round-trip", async () => {
    const session = {
      sessionId: "session-ready",
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
        bootstrapToken: "bootstrap-ready",
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(true);
    mockSend.mockResolvedValueOnce({
      microvmId: "microvm-ready",
      $metadata: { requestId: "run-ready", httpStatusCode: 200 },
    });
    mockQuery.mockResolvedValueOnce({
      ...session,
      status: "running",
      microvmId: "microvm-ready",
      connectionId: "connection-ready",
      relayReadyAt: Date.now(),
    });
    const infoSpy = jest.spyOn(console, "info").mockImplementation();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation();

    await expect(
      ensureAwsLambdaMicrovmConnection("user-ready"),
    ).resolves.toBeDefined();

    expect(mockRelayRun).not.toHaveBeenCalled();
    expect(mockRealtimeUnsubscribe).toHaveBeenCalled();
    expect(mockRealtimeClose).toHaveBeenCalledTimes(1);
    infoSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("keeps the readiness command for older guest images", async () => {
    const session = {
      sessionId: "session-legacy",
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
        bootstrapToken: "bootstrap-legacy",
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(true);
    mockSend.mockResolvedValueOnce({
      microvmId: "microvm-legacy",
      $metadata: { requestId: "run-legacy", httpStatusCode: 200 },
    });
    mockQuery.mockResolvedValueOnce({
      ...session,
      status: "running",
      microvmId: "microvm-legacy",
      connectionId: "connection-legacy",
    });
    const infoSpy = jest.spyOn(console, "info").mockImplementation();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation();

    await expect(
      ensureAwsLambdaMicrovmConnection("user-legacy"),
    ).resolves.toBeDefined();

    expect(mockRelayRun).toHaveBeenCalledWith("echo ready", {
      timeoutMs: 5_000,
      displayName: "",
    });
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
    expect(mockRealtimeClose).toHaveBeenCalledTimes(1);

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
    expect(runInput).not.toHaveProperty("idlePolicy");

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

  it("cleans up a readiness watch whose initial value is delivered synchronously", async () => {
    const session = {
      sessionId: "session-sync",
      status: "starting" as const,
      region: "us-east-1",
      imageIdentifier: process.env.AWS_LAMBDA_MICROVM_IMAGE_ID,
      imageVersion: "6.0",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bootstrapExpiresAt: Date.now() + 60_000,
    };
    mockRealtimeOnUpdate.mockImplementationOnce((_query, _args, callback) => {
      callback({
        ...session,
        status: "running",
        microvmId: "microvm-sync",
        connectionId: "connection-sync",
        relayReadyAt: Date.now(),
      });
      return mockRealtimeUnsubscribe;
    });
    mockMutation
      .mockResolvedValueOnce({
        created: true,
        session,
        bootstrapToken: "bootstrap-sync",
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(true);
    mockSend.mockResolvedValueOnce({
      microvmId: "microvm-sync",
      $metadata: { requestId: "run-sync", httpStatusCode: 200 },
    });
    const infoSpy = jest.spyOn(console, "info").mockImplementation();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation();

    await expect(
      ensureAwsLambdaMicrovmConnection("user-sync"),
    ).resolves.toBeDefined();

    expect(mockRealtimeUnsubscribe).toHaveBeenCalled();
    expect(mockRealtimeClose).toHaveBeenCalledTimes(1);
    infoSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("does not mask a successful launch when readiness teardown fails", async () => {
    const session = {
      sessionId: "session-close-failure",
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
        bootstrapToken: "bootstrap-close-failure",
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(true);
    mockSend.mockResolvedValueOnce({
      microvmId: "microvm-close-failure",
      $metadata: { requestId: "run-close-failure", httpStatusCode: 200 },
    });
    mockQuery.mockResolvedValueOnce({
      ...session,
      status: "running",
      microvmId: "microvm-close-failure",
      connectionId: "connection-close-failure",
      relayReadyAt: Date.now(),
    });
    mockRealtimeClose.mockRejectedValueOnce(new Error("socket close failed"));
    const infoSpy = jest.spyOn(console, "info").mockImplementation();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    await expect(
      ensureAwsLambdaMicrovmConnection("user-close-failure"),
    ).resolves.toBeDefined();

    expect(
      warnSpy.mock.calls.some(([value]) =>
        String(value).includes(
          "cloud_sandbox_readiness_subscription_close_failed",
        ),
      ),
    ).toBe(true);
    infoSpy.mockRestore();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("times out a silent readiness subscription and closes it", async () => {
    jest.useFakeTimers();
    const session = {
      sessionId: "session-timeout",
      status: "starting" as const,
      region: "us-east-1",
      imageIdentifier: process.env.AWS_LAMBDA_MICROVM_IMAGE_ID,
      imageVersion: "6.0",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bootstrapExpiresAt: Date.now() + 60_000,
    };
    mockRealtimeOnUpdate.mockImplementation(() => mockRealtimeUnsubscribe);
    mockMutation
      .mockResolvedValueOnce({
        created: true,
        session,
        bootstrapToken: "bootstrap-timeout",
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockSend
      .mockResolvedValueOnce({
        microvmId: "microvm-timeout",
        $metadata: { requestId: "run-timeout", httpStatusCode: 200 },
      })
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });
    const errorSpy = jest.spyOn(console, "error").mockImplementation();
    const infoSpy = jest.spyOn(console, "info").mockImplementation();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation();

    const pending = expect(
      ensureAwsLambdaMicrovmConnection("user-timeout"),
    ).rejects.toThrow("Failed creating AWS Lambda MicroVM sandbox");
    await jest.advanceTimersByTimeAsync(90_000);
    await pending;

    expect(mockRealtimeUnsubscribe).toHaveBeenCalled();
    expect(mockRealtimeClose).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
    infoSpy.mockRestore();
    debugSpy.mockRestore();
    jest.useRealTimers();
  });

  it("does not spend the guest readiness budget on AWS allocation", async () => {
    jest.useFakeTimers();
    const session = {
      sessionId: "session-slow-allocation",
      status: "starting" as const,
      region: "us-east-1",
      imageIdentifier: process.env.AWS_LAMBDA_MICROVM_IMAGE_ID,
      imageVersion: "6.0",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bootstrapExpiresAt: Date.now() + 180_000,
    };
    let deliverSession!: (value: unknown) => void;
    let acceptRun!: (value: unknown) => void;
    mockRealtimeOnUpdate.mockImplementationOnce((_query, _args, callback) => {
      deliverSession = callback;
      return mockRealtimeUnsubscribe;
    });
    mockMutation
      .mockResolvedValueOnce({
        created: true,
        session,
        bootstrapToken: "bootstrap-slow-allocation",
        cleanupCandidates: [],
      })
      .mockResolvedValueOnce(true);
    mockSend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acceptRun = resolve;
        }),
    );
    const infoSpy = jest.spyOn(console, "info").mockImplementation();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation();

    const pending = ensureAwsLambdaMicrovmConnection("user-slow-allocation");
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(90_000);
    acceptRun({
      microvmId: "microvm-slow-allocation",
      $metadata: { requestId: "run-slow-allocation", httpStatusCode: 200 },
    });
    deliverSession({
      ...session,
      status: "running",
      microvmId: "microvm-slow-allocation",
      connectionId: "connection-slow-allocation",
      relayReadyAt: Date.now(),
    });

    await expect(pending).resolves.toBeDefined();
    infoSpy.mockRestore();
    debugSpy.mockRestore();
    jest.useRealTimers();
  });

  it.each(["terminal_status", "query_error"] as const)(
    "closes readiness subscriptions on %s",
    async (mode) => {
      const session = {
        sessionId: `session-${mode}`,
        status: "starting" as const,
        region: "us-east-1",
        imageIdentifier: process.env.AWS_LAMBDA_MICROVM_IMAGE_ID,
        imageVersion: "6.0",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        bootstrapExpiresAt: Date.now() + 60_000,
      };
      mockRealtimeOnUpdate.mockImplementation(
        (_query, _args, callback, onError) => {
          queueMicrotask(() => {
            if (mode === "query_error") onError(new Error("query failed"));
            else callback({ ...session, status: "terminated" });
          });
          return mockRealtimeUnsubscribe;
        },
      );
      mockMutation
        .mockResolvedValueOnce({
          created: true,
          session,
          bootstrapToken: `bootstrap-${mode}`,
          cleanupCandidates: [],
        })
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);
      mockSend
        .mockResolvedValueOnce({
          microvmId: `microvm-${mode}`,
          $metadata: { requestId: `run-${mode}`, httpStatusCode: 200 },
        })
        .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });
      const errorSpy = jest.spyOn(console, "error").mockImplementation();
      const infoSpy = jest.spyOn(console, "info").mockImplementation();
      const debugSpy = jest.spyOn(console, "debug").mockImplementation();

      await expect(
        ensureAwsLambdaMicrovmConnection(`user-${mode}`),
      ).rejects.toThrow("Failed creating AWS Lambda MicroVM sandbox");

      expect(mockRealtimeUnsubscribe).toHaveBeenCalled();
      expect(mockRealtimeClose).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
      infoSpy.mockRestore();
      debugSpy.mockRestore();
    },
  );

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
    expect(mockRealtimeClose).toHaveBeenCalledTimes(1);

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
});
