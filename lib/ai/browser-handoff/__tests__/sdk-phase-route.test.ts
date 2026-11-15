/**
 * The preview GET route with the actual capture helper: only the SDK, auth,
 * Convex and analytics boundaries are replaced. Proves the stream-status SDK
 * phase group reaches the existing unavailable event unchanged.
 */
import type { NextRequest } from "next/server";
import { phLogger } from "@/lib/posthog/server";
import { Sandbox, TimeoutError } from "@e2b/code-interpreter";

jest.mock("server-only", () => ({}));
jest.mock("next/server", () => ({
  after: jest.fn(),
  NextResponse: {
    json: (body: unknown, init: { status: number }) => ({
      status: init.status,
      json: async () => body,
    }),
  },
}));
jest.mock("@/convex/_generated/api", () => ({
  api: { browserHandoffs: new Proxy({}, { get: (_target, name) => name }) },
}));
jest.mock("@/lib/auth/get-user-id", () => ({ getUserID: async () => "owner" }));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({
    query: async () => ({
      sessionId: "a".repeat(32),
      runId: `run_${"a".repeat(26)}`,
      userId: "owner",
      sandboxId: "sandbox",
      triggerRegion: null,
      directory: "/dev/shm/hackerai-browser-0123456789abcdef01234567",
      expiresAt: Number.MAX_SAFE_INTEGER,
      state: "agent",
      runActive: true,
    }),
  }),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn(), info: jest.fn(), flush: jest.fn() },
}));
jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: { getInfo: jest.fn(), connect: jest.fn() },
  CommandExitError: class extends Error {},
  TimeoutError: class extends Error {},
}));
jest.mock("@/lib/ai/tools/utils/e2b-cluster", () => ({
  getE2BClusterRouting: () => ({
    createCluster: {
      cluster: "us",
      template: "template",
      connectionOptions: {},
    },
  }),
}));
jest.mock("@/lib/ai/tools/utils/sandbox-command-options", () => ({
  buildSandboxCommandOptions: () => ({ user: "root" }),
}));

let get: typeof import("@/app/api/agent/browser/[sessionId]/route").GET;
beforeAll(async () => {
  const original = process.env.CONVEX_SERVICE_ROLE_KEY;
  process.env.CONVEX_SERVICE_ROLE_KEY = "test-only-service-key";
  try {
    ({ GET: get } = await import("@/app/api/agent/browser/[sessionId]/route"));
  } finally {
    if (original === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
    else process.env.CONVEX_SERVICE_ROLE_KEY = original;
  }
});
afterEach(() => jest.restoreAllMocks());

const handle = (error: unknown) => ({
  pid: 1,
  wait: jest.fn(async () => {
    throw error;
  }),
  kill: jest.fn(),
  disconnect: jest.fn(),
});

it.each(["start", "wait"] as const)(
  "forwards the %s phase into the existing GET-unavailable event",
  async (phase) => {
    jest.clearAllMocks();
    jest
      .spyOn(performance, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_500);
    const error = new TimeoutError(
      "PRIVATE deadline https://private.invalid/?token=PRIVATE",
    );
    const waiting = handle(error);
    const run = jest.fn(async () => {
      if (phase === "start") throw error;
      return waiting;
    });
    jest.mocked(Sandbox.getInfo).mockResolvedValue({
      state: "running",
      metadata: { userID: "owner", e2bCluster: "us", template: "template" },
    } as never);
    jest.mocked(Sandbox.connect).mockResolvedValue({
      files: { read: async () => "default\n" },
      commands: { run },
    } as never);

    const response = await get(
      {
        headers: new Headers(),
        nextUrl: new URL("https://preview.example/api/agent/browser/test"),
      } as NextRequest,
      { params: Promise.resolve({ sessionId: "a".repeat(32) }) },
    );

    expect(response.status).toBe(503);
    expect(run).toHaveBeenCalledTimes(1);
    expect(waiting.wait).toHaveBeenCalledTimes(phase === "wait" ? 1 : 0);
    expect(phLogger.info).toHaveBeenCalledTimes(1);
    const [event, fields] = jest.mocked(phLogger.info).mock.calls[0];
    expect(event).toBe("agent_browser_preview_get_unavailable");
    expect(fields).toMatchObject({
      failure_stage: "capture_frame",
      capture_stage: "stream_status",
      capture_error_kind: "timeout",
      capture_command_exit_code: "none",
      capture_sdk_command_diagnostic_version: 1,
      capture_sdk_command_phase: phase,
    });
    if (phase === "wait")
      expect(fields).toHaveProperty("capture_sdk_start_ack_latency", "lt3s");
    else expect(fields).not.toHaveProperty("capture_sdk_start_ack_latency");
    expect(JSON.stringify(fields)).not.toContain("PRIVATE");
  },
);
