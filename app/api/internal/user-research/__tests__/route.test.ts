import { createHash } from "node:crypto";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { NextRequest } from "next/server";

jest.mock("next/server", () => ({
  NextResponse: class MockNextResponse {
    status: number;
    headers: Headers;
    private body: unknown;

    constructor(body?: unknown, init?: ResponseInit) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }

    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(body, init);
    }

    async json() {
      return this.body;
    }
  },
}));

const triggerTask = jest.fn<any>();
const retrieveRun = jest.fn<any>();
jest.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: (...args: unknown[]) => triggerTask(...args) },
  runs: { retrieve: (...args: unknown[]) => retrieveRun(...args) },
}));

const runnerKey = "pm-runner-test-secret";
const originalHash = process.env.PM_USER_RESEARCH_RUNNER_KEY_SHA256;

const validPayload = {
  question: "What recurring work creates the most customer value?",
  cohortLabel: "PostHog top-spender research cohort",
  userIds: ["user-1", "user-2", "user-3"],
  cohortSelectedAt: Date.UTC(2026, 7, 25),
  selectionQueryFingerprint:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  maxChatsPerUser: 12,
};

const validTriggeredPayload = {
  ...validPayload,
  cohortSource: "posthog",
  posthogProjectId: 144137,
  selectionLimitations: [],
  samplingMode: "representative",
};

const validResult = {
  analysisId: "c6e714d8-1da5-4ef4-be1c-39363a0c83fc",
  status: "completed",
  userIds: validPayload.userIds,
  failedProfiles: 0,
  usersAnalyzed: 3,
  report: {
    answerToQuestion: "Autonomous workflows create recurring value.",
    executiveSummary: "The cohort values autonomy and execution.",
    avatars: [
      {
        name: "Independent security practitioner",
        definition: "A solo practitioner using assisted security workflows.",
        mainJob: "Complete bounded security investigations.",
        supportingUserTypes: ["solo_pentester"],
        pains: ["Manual multi-step work"],
        desiredOutcomes: ["Faster validated results"],
        reasonsToPay: ["Execution and continuity"],
        productFeatures: ["Agent mode"],
        objectionsAndTrustNeeds: ["Clear sandbox boundaries"],
        acquisitionHypotheses: ["Test practitioner-focused education"],
        messageHypotheses: ["Test faster workflow completion"],
        evidenceUserCount: 3,
        confidence: "high",
      },
    ],
    primaryAvatar: "Independent security practitioner",
    secondaryAvatars: [],
    crossCohortPatterns: [
      {
        pattern: "Multi-step Agent usage",
        basis: "observed",
        evidenceUserCount: 3,
        confidence: "high",
      },
    ],
    unknowns: ["Profession and authorization remain unknown"],
    followUpExperiments: [
      {
        hypothesis: "Verified practitioners value faster activation.",
        test: "Run a verified-practitioner cohort.",
        successMetric: "Activation and repeat Agent usage",
        baselineRequired: true,
      },
    ],
    privacyNote: "Aggregate findings only.",
    researchBasis: {
      cohortSource: "posthog",
      posthogProjectId: 144137,
      cohortSelectedAt: validPayload.cohortSelectedAt,
      selectionQueryFingerprint: validPayload.selectionQueryFingerprint,
      selectionLimitations: [],
      samplingMode: "representative",
      causalAttributionConfidence: "low",
    },
    coverage: {
      usersRequested: 3,
      usersAnalyzed: 3,
      profilesFailed: 0,
      chatsReviewed: 36,
      messagesReviewed: 622,
    },
  },
};

function request({
  token = runnerKey,
  body = validPayload,
  idempotencyKey = "research-request-123",
  contentLength,
  runId,
  rawBody,
}: {
  token?: string | null;
  body?: unknown;
  idempotencyKey?: string | null;
  contentLength?: string | null;
  runId?: string;
  rawBody?: string;
} = {}): NextRequest {
  const encodedBody = new TextEncoder().encode(rawBody ?? JSON.stringify(body));
  const headers = new Headers({ "x-request-id": "request-123" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  if (contentLength !== null) {
    headers.set(
      "content-length",
      contentLength ?? String(encodedBody.byteLength),
    );
  }
  const nextUrl = new URL("https://hackerai.co/api/internal/user-research");
  if (runId) nextUrl.searchParams.set("runId", runId);
  return {
    headers,
    nextUrl,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encodedBody);
        controller.close();
      },
    }),
  } as unknown as NextRequest;
}

describe("PM user research gateway", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PM_USER_RESEARCH_RUNNER_KEY_SHA256 = createHash("sha256")
      .update(runnerKey)
      .digest("hex");
    triggerTask.mockResolvedValue({ id: "run_gateway123" });
  });

  afterAll(() => {
    if (originalHash === undefined) {
      delete process.env.PM_USER_RESEARCH_RUNNER_KEY_SHA256;
    } else {
      process.env.PM_USER_RESEARCH_RUNNER_KEY_SHA256 = originalHash;
    }
  });

  it("starts only the PM research task with server-owned requester identity", async () => {
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    const { POST } = await import("../route");

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(body).toEqual({
      runId: "run_gateway123",
      status: "queued",
      statusPath: "/api/internal/user-research?runId=run_gateway123",
    });
    expect(triggerTask).toHaveBeenCalledWith(
      "pm-user-research",
      { ...validTriggeredPayload, requestedBy: "pm-gateway" },
      {
        idempotencyKey: "pm-research:research-request-123",
        idempotencyKeyTTL: "24h",
        tags: ["pm-user-research-gateway"],
      },
    );
    expect(JSON.stringify(body)).not.toContain("user-1");
    expect(infoSpy).toHaveBeenCalledWith(expect.not.stringContaining("user-1"));
    infoSpy.mockRestore();
  });

  it("accepts an optional Linear issue reference for tracking", async () => {
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    const { POST } = await import("../route");

    const response = await POST(
      request({ body: { ...validPayload, linearIssueId: "HAC-65" } }),
    );

    expect(response.status).toBe(202);
    expect(triggerTask).toHaveBeenCalledWith(
      "pm-user-research",
      {
        ...validTriggeredPayload,
        linearIssueId: "HAC-65",
        requestedBy: "pm-gateway",
      },
      expect.any(Object),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"linear_issue_id":"HAC-65"'),
    );
    infoSpy.mockRestore();
  });

  it("rejects an invalid credential before parsing or triggering", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const invalid = request({ token: "wrong-secret" });
    const getReader = jest.spyOn(invalid.body!, "getReader");
    const { POST } = await import("../route");

    const response = await POST(invalid);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(getReader).not.toHaveBeenCalled();
    expect(triggerTask).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.not.stringContaining("wrong-secret"),
    );
    warnSpy.mockRestore();
  });

  it("rejects invalid cohorts and missing idempotency keys", async () => {
    const { POST } = await import("../route");

    const missingKey = await POST(request({ idempotencyKey: null }));
    expect(missingKey.status).toBe(400);

    const invalidCohort = await POST(
      request({ body: { ...validPayload, userIds: ["user-1", "user-2"] } }),
    );
    expect(invalidCohort.status).toBe(400);
    expect(triggerTask).not.toHaveBeenCalled();
  });

  it("accepts missing or rewritten content lengths while bounding the body", async () => {
    const { POST } = await import("../route");

    const missing = await POST(request({ contentLength: null }));
    expect(missing.status).toBe(202);

    const malformed = await POST(request({ contentLength: "not-a-number" }));
    expect(malformed.status).toBe(202);

    expect(triggerTask).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized declared and streamed bodies", async () => {
    const { POST } = await import("../route");

    const oversized = await POST(request({ contentLength: String(33 * 1024) }));
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      error: "payload_too_large",
    });

    const oversizedStream = await POST(
      request({
        contentLength: "1",
        rawBody: "x".repeat(33 * 1024),
      }),
    );
    expect(oversizedStream.status).toBe(413);
    await expect(oversizedStream.json()).resolves.toEqual({
      error: "payload_too_large",
    });
    expect(triggerTask).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON after bounded reading", async () => {
    const { POST } = await import("../route");

    const response = await POST(request({ rawBody: "{" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_json" });
    expect(triggerTask).not.toHaveBeenCalled();
  });

  it("returns the validated result with cohort user IDs", async () => {
    retrieveRun.mockResolvedValue({
      taskIdentifier: "pm-user-research",
      tags: ["pm-user-research-gateway"],
      isSuccess: true,
      isFailed: false,
      isCancelled: false,
      output: validResult,
    });
    const { GET } = await import("../route");

    const response = await GET(request({ runId: "run_gateway123" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      runId: "run_gateway123",
      status: "completed",
      result: validResult,
    });
  });

  it("does not expose unrelated Trigger runs", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    retrieveRun.mockResolvedValue({
      taskIdentifier: "agent-long",
      tags: [],
      isSuccess: true,
      output: { private: "agent output" },
    });
    const { GET } = await import("../route");

    const response = await GET(request({ runId: "run_agent123" }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "run_not_found" });
    expect(JSON.stringify(await response.json())).not.toContain("agent output");
    warnSpy.mockRestore();
  });

  it("returns a generic failure without provider diagnostics", async () => {
    retrieveRun.mockResolvedValue({
      taskIdentifier: "pm-user-research",
      tags: ["pm-user-research-gateway"],
      isSuccess: false,
      isFailed: true,
      isCancelled: false,
      error: { message: "provider secret diagnostic" },
    });
    const { GET } = await import("../route");

    const response = await GET(request({ runId: "run_gateway123" }));
    const body = await response.json();

    expect(body).toEqual({
      runId: "run_gateway123",
      status: "failed",
      error: "research_run_failed",
    });
    expect(JSON.stringify(body)).not.toContain("provider secret diagnostic");
  });
});
