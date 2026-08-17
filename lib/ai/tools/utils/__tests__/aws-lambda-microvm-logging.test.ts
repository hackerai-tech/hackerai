const mockSend = jest.fn();
const mockDestroy = jest.fn();
const mockMutation = jest.fn();
const mockQuery = jest.fn();

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

jest.mock("../centrifugo-sandbox", () => ({
  CentrifugoSandbox: jest.fn(),
}));

import { ensureAwsLambdaMicrovmConnection } from "../aws-lambda-microvm";

describe("AWS Lambda MicroVM development logging", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: "development",
      AWS_PROFILE: "hackerai-microvm-admin",
      AWS_LAMBDA_MICROVM_REGION: "us-east-1",
      AWS_LAMBDA_MICROVM_IMAGE_ID:
        "arn:aws:lambda:us-east-1:630609837323:microvm-image:hackerai-cloud-agent",
      AWS_LAMBDA_MICROVM_IMAGE_VERSION: "6.0",
      AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN:
        "arn:aws:iam::630609837323:role/hackerai-microvm-execution",
      CONVEX_SERVICE_ROLE_KEY: "service-role-secret-value",
      CENTRIFUGO_WS_URL: "wss://relay.example.test/connection/websocket",
      CENTRIFUGO_TOKEN_SECRET: "centrifugo-secret-value",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
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
});
