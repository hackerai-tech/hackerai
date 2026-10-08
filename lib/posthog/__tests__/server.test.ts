import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockCapture = jest.fn();
const mockCaptureException = jest.fn();
const mockGetFlag = jest.fn();
const mockGetFeatureFlagResult = jest.fn();
const mockEvaluateFlags = jest.fn();
const mockPostHogClient = jest.fn(() => ({
  capture: mockCapture,
  captureException: mockCaptureException,
  getFeatureFlagResult: mockGetFeatureFlagResult,
  evaluateFlags: mockEvaluateFlags,
}));
const mockEmitPostHogLog = jest.fn(() => true);

jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: mockPostHogClient,
}));

jest.mock("@/lib/posthog/logs", () => ({
  emitPostHogLog: mockEmitPostHogLog,
  flushPostHogLogs: jest.fn(),
}));

const {
  arePostHogSurveyFlagsEnabled,
  getPostHogFeatureFlagForUser,
  getPostHogBooleanFlagDecisionForUser,
  getPostHogFeatureFlagValueForUser,
  getPostHogFeatureFlagRawValueForUser,
  getPostHogFeatureFlagVariantForUser,
  phLogger,
} = require("../server") as typeof import("../server");

describe("phLogger", () => {
  beforeEach(() => {
    mockCapture.mockClear();
    mockCaptureException.mockClear();
    mockGetFlag.mockReset();
    mockGetFeatureFlagResult.mockReset();
    mockEvaluateFlags.mockReset();
    mockPostHogClient.mockClear();
    mockEmitPostHogLog.mockClear();
  });

  it("requires all headless survey targeting flags and fails closed on missing flags", async () => {
    const keys = ["survey-rollout", "survey-targeting"];
    mockGetFlag.mockReturnValue(true);
    mockEvaluateFlags.mockResolvedValue({ getFlag: mockGetFlag });
    await expect(arePostHogSurveyFlagsEnabled(keys, "user")).resolves.toBe(
      true,
    );
    expect(mockEvaluateFlags).toHaveBeenCalledWith("user", { flagKeys: keys });
    mockGetFlag.mockImplementation((key: string) =>
      key === "survey-rollout" ? true : undefined,
    );
    await expect(arePostHogSurveyFlagsEnabled(keys, "user")).resolves.toBe(
      false,
    );
    mockEvaluateFlags.mockRejectedValueOnce(new Error("timeout"));
    await expect(arePostHogSurveyFlagsEnabled(keys, "user")).resolves.toBe(
      false,
    );
  });

  it("evaluates boolean flags for the authenticated distinct id and fails closed", async () => {
    mockGetFlag.mockReturnValueOnce(true);
    mockEvaluateFlags.mockResolvedValueOnce({ getFlag: mockGetFlag });
    await expect(
      getPostHogFeatureFlagForUser("agent-subagents", "user_123"),
    ).resolves.toBe(true);
    expect(mockEvaluateFlags).toHaveBeenCalledWith("user_123", {
      flagKeys: ["agent-subagents"],
    });
    expect(mockGetFlag).toHaveBeenCalledWith("agent-subagents");

    mockEvaluateFlags.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      getPostHogFeatureFlagForUser("agent-subagents", "user_123"),
    ).resolves.toBe(false);
  });

  it("distinguishes a disabled boolean flag from an unavailable evaluation", async () => {
    mockGetFlag.mockReturnValueOnce(false);
    mockEvaluateFlags.mockResolvedValueOnce({ getFlag: mockGetFlag });
    await expect(
      getPostHogBooleanFlagDecisionForUser("history", "user"),
    ).resolves.toBe(false);
    mockEvaluateFlags.mockRejectedValueOnce(new Error("private service error"));
    await expect(
      getPostHogBooleanFlagDecisionForUser("history", "user"),
    ).resolves.toBeNull();
    mockGetFlag.mockReturnValueOnce(false);
    mockEvaluateFlags.mockResolvedValueOnce({ getFlag: mockGetFlag });
    await expect(
      getPostHogFeatureFlagValueForUser("example-feature-flag", "user_123"),
    ).resolves.toBe(false);

    mockEvaluateFlags.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      getPostHogFeatureFlagValueForUser("example-feature-flag", "user_123"),
    ).resolves.toBeNull();
  });

  it("evaluates multivariate flags and ignores non-variant values", async () => {
    mockGetFeatureFlagResult.mockResolvedValueOnce({
      enabled: true,
      variant: "test",
    });
    await expect(
      getPostHogFeatureFlagVariantForUser(
        "hac46-pro-monthly-29-pricing",
        "user_123",
        {
          sendFeatureFlagEvents: false,
          personProperties: { subscription_tier: "pro" },
        },
      ),
    ).resolves.toBe("test");
    expect(mockGetFeatureFlagResult).toHaveBeenLastCalledWith(
      "hac46-pro-monthly-29-pricing",
      "user_123",
      {
        sendFeatureFlagEvents: false,
        personProperties: { subscription_tier: "pro" },
      },
    );

    mockGetFlag.mockReturnValueOnce(true);
    mockEvaluateFlags.mockResolvedValueOnce({ getFlag: mockGetFlag });
    await expect(
      getPostHogFeatureFlagVariantForUser(
        "hac46-pro-monthly-29-pricing",
        "user_123",
      ),
    ).resolves.toBeUndefined();

    mockEvaluateFlags.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      getPostHogFeatureFlagVariantForUser(
        "hac46-pro-monthly-29-pricing",
        "user_123",
      ),
    ).resolves.toBeUndefined();
  });

  it.each(["test", true, false, undefined, 42])(
    "preserves raw flag value %s and unavailable results",
    async (value) => {
      mockGetFlag.mockReturnValueOnce(value);
      mockEvaluateFlags.mockResolvedValueOnce({ getFlag: mockGetFlag });
      await expect(
        getPostHogFeatureFlagRawValueForUser("retention", "user"),
      ).resolves.toBe(
        typeof value === "boolean" || typeof value === "string" ? value : null,
      );
      expect(mockEvaluateFlags).toHaveBeenCalledWith("user", {
        flagKeys: ["retention"],
      });
    },
  );

  it("preserves variant lookups with automatic exposure and suppressed lookup failures", async () => {
    mockGetFlag.mockReturnValueOnce("control");
    mockEvaluateFlags.mockResolvedValueOnce({ getFlag: mockGetFlag });
    await expect(
      getPostHogFeatureFlagVariantForUser("experiment", "user", {
        personProperties: { subscription_tier: "pro" },
      }),
    ).resolves.toBe("control");
    expect(mockEvaluateFlags).toHaveBeenLastCalledWith("user", {
      flagKeys: ["experiment"],
      personProperties: { subscription_tier: "pro" },
    });
    expect(mockGetFeatureFlagResult).not.toHaveBeenCalled();

    mockGetFeatureFlagResult.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      getPostHogFeatureFlagVariantForUser("experiment", "user", {
        sendFeatureFlagEvents: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps info and warning records in Logs without duplicating product events", () => {
    phLogger.info("request_finished", { requestId: "req_123" });
    phLogger.warn("retry_scheduled", { requestId: "req_123" });

    expect(mockEmitPostHogLog).toHaveBeenCalledTimes(2);
    expect(mockPostHogClient).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("falls back to the console when a structured warning cannot be emitted", () => {
    const consoleWarn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    mockEmitPostHogLog.mockReturnValueOnce(false);

    phLogger.warn("retry_scheduled", { requestId: "req_123" });

    expect(consoleWarn).toHaveBeenCalledWith("retry_scheduled", {
      requestId: "req_123",
    });
    expect(mockPostHogClient).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();

    consoleWarn.mockRestore();
  });

  it("continues sending errors to exception tracking", () => {
    phLogger.error("provider_failed", {
      userId: "user_123",
      error: new Error("provider failed"),
      requestId: "req_123",
    });

    expect(mockEmitPostHogLog).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("redacts signed URLs and raw causes before exception capture", () => {
    const signedUrl =
      "https://bucket.s3.amazonaws.com/user-files/user_123/private-image.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key&X-Amz-Signature=signature-secret";
    const error = Object.assign(
      new Error(`Provider could not fetch ${signedUrl}`),
      {
        cause: new Error(`Upstream rejected ${signedUrl}`),
      },
    );

    phLogger.error(`provider_failed ${signedUrl}`, {
      userId: "user_123",
      error,
      requestId: "req_123",
      message: signedUrl,
    });

    const capturedError = mockCaptureException.mock.calls[0]?.[0] as Error;
    const capturedProperties = mockCaptureException.mock.calls[0]?.[2];
    const emittedLog = mockEmitPostHogLog.mock.calls[0]?.[0];
    const serialized = JSON.stringify({
      message: capturedError.message,
      stack: capturedError.stack,
      properties: capturedProperties,
      log: emittedLog,
    });

    expect(capturedError).toBeInstanceOf(Error);
    expect(serialized).toContain("[Redacted signed URL]");
    expect(serialized).not.toContain("user-files");
    expect(serialized).not.toContain("access-key");
    expect(serialized).not.toContain("signature-secret");
    expect("cause" in capturedError).toBe(false);
    expect(emittedLog?.body).toBe("provider_failed [Redacted signed URL]");
    expect(capturedProperties?.message).toBe(
      "provider_failed [Redacted signed URL]",
    );
  });

  it("redacts signed URLs from error console fallbacks", () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const signedUrl =
      "https://bucket.s3.amazonaws.com/user-files/user_123/private-image.png?X-Amz-Credential=access-key&X-Amz-Signature=signature-secret";
    mockCaptureException.mockImplementationOnce(() => {
      throw new Error(`Telemetry failed for ${signedUrl}`);
    });

    try {
      phLogger.error(`provider_failed ${signedUrl}`, {
        error: new Error(`Provider failed for ${signedUrl}`),
        message: signedUrl,
      });

      const serialized = JSON.stringify(consoleError.mock.calls);

      expect(serialized).toContain("[Redacted signed URL]");
      expect(serialized).not.toContain("user-files");
      expect(serialized).not.toContain("access-key");
      expect(serialized).not.toContain("signature-secret");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("omits enumerable provider payloads from error console fallbacks", () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const privateAttachmentText = "PRIVATE_ATTACHMENT_TEXT";
    const inlineImage = "data:image/png;base64,PRIVATE_INLINE_IMAGE";
    const error = Object.assign(new Error("Provider request failed"), {
      responseBody: JSON.stringify({
        file_annotations: [{ parsed_content: privateAttachmentText }],
      }),
      data: { preview: inlineImage },
    });
    mockCaptureException.mockImplementationOnce(() => {
      throw new Error("telemetry unavailable");
    });

    try {
      phLogger.error("provider_failed", { error });

      const safeFields = consoleError.mock.calls[0]?.[1] as
        { error?: Error } | undefined;
      const serialized = JSON.stringify(consoleError.mock.calls);
      expect(safeFields?.error).toBeInstanceOf(Error);
      expect(safeFields?.error?.message).toBe("Provider request failed");
      expect("responseBody" in (safeFields?.error ?? {})).toBe(false);
      expect(serialized).not.toContain(privateAttachmentText);
      expect(serialized).not.toContain(inlineImage);
      expect(serialized).not.toContain("responseBody");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("passes stable event UUIDs to PostHog without leaking them into properties", () => {
    phLogger.event("checkout_started", {
      userId: "user_123",
      eventUuid: "b01882bb-b996-52d2-aaca-b2f4edc0fa3d",
      checkout_attempt_id: "ca_12345678",
    });

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "checkout_started",
      uuid: "b01882bb-b996-52d2-aaca-b2f4edc0fa3d",
      properties: {
        checkout_attempt_id: "ca_12345678",
      },
    });
  });
});
