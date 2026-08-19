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
  linearIssueId: "HAC-65",
  question: "What recurring work creates the most customer value?",
  cohortLabel: "Approved production research cohort",
  userIds: ["user-1", "user-2", "user-3"],
  maxChatsPerUser: 12,
};

const validResult = {
  analysisId: "c6e714d8-1da5-4ef4-be1c-39363a0c83fc",
  status: "completed",
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
    crossCohortPatterns: ["Multi-step Agent usage"],
    unknowns: ["Profession and authorization remain unknown"],
    followUpExperiments: [
      {
        hypothesis: "Verified practitioners value faster activation.",
        test: "Run an approved verified-practitioner cohort.",
        successMetric: "Activation and repeat Agent usage",
      },
    ],
    privacyNote: "Aggregate findings only.",
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
  runId,
}: {
  token?: string | null;
  body?: unknown;
  idempotencyKey?: string | null;
  runId?: string;
} = {}): NextRequest {
  const headers = new Headers({ "x-request-id": "request-123" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  const nextUrl = new URL("https://hackerai.co/api/internal/user-research");
  if (runId) nextUrl.searchParams.set("runId", runId);
  return {
    headers,
    nextUrl,
    json: async () => body,
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
      { ...validPayload, requestedBy: "pm-gateway" },
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

  it("rejects an invalid credential before parsing or triggering", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const invalid = request({ token: "wrong-secret" });
    invalid.json = jest.fn() as never;
    const { POST } = await import("../route");

    const response = await POST(invalid);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(invalid.json).not.toHaveBeenCalled();
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

  it("returns only the validated aggregate result for a gateway run", async () => {
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
