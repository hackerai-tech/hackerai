/**
 * The preview GET and POST routes with the actual browser-handoff server
 * helpers: only the SDK, auth, Convex and analytics boundaries are replaced.
 * Proves closed diagnostic groups reach the existing unavailable events
 * unchanged and that the sandbox identity guards still refuse connection.
 */
import type { NextRequest } from "next/server";
import { phLogger } from "@/lib/posthog/server";
import { Sandbox, TimeoutError } from "@e2b/code-interpreter";
import {
  BrowserPreviewUnavailable,
  browserSandboxIdentityFailureContext,
} from "@/lib/ai/browser-handoff/server";

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
      sandboxId: "PRIVATE_SANDBOX_ID",
      triggerRegion: null,
      directory: "/dev/shm/hackerai-browser-0123456789abcdef01234567",
      expiresAt: Number.MAX_SAFE_INTEGER,
      // Accepted by GET and by every POST action that connects.
      state: "recovery",
      runActive: true,
      controlledSessionName: "default",
    }),
    // Every claim, grant check, abort and finish succeeds.
    mutation: async () => true,
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

type Route = typeof import("@/app/api/agent/browser/[sessionId]/route");
let get: Route["GET"];
let post: Route["POST"];
beforeAll(async () => {
  const original = process.env.CONVEX_SERVICE_ROLE_KEY;
  process.env.CONVEX_SERVICE_ROLE_KEY = "test-only-service-key";
  try {
    ({ GET: get, POST: post } =
      await import("@/app/api/agent/browser/[sessionId]/route"));
  } finally {
    if (original === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
    else process.env.CONVEX_SERVICE_ROLE_KEY = original;
  }
});
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const SESSION_ID = "a".repeat(32);
const ORIGIN = "https://preview.example";
const routeContext = () => ({
  params: Promise.resolve({ sessionId: SESSION_ID }),
});
const getRequest = () =>
  ({
    headers: new Headers(),
    nextUrl: new URL(`${ORIGIN}/api/agent/browser/${SESSION_ID}`),
  }) as NextRequest;
const postRequest = (body: unknown) =>
  ({
    url: `${ORIGIN}/api/agent/browser/${SESSION_ID}`,
    headers: new Headers({
      origin: ORIGIN,
      "content-type": "application/json",
    }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        controller.close();
      },
    }),
  }) as unknown as NextRequest;

const loggedEvent = () => {
  expect(phLogger.info).toHaveBeenCalledTimes(1);
  const [event, fields] = jest.mocked(phLogger.info).mock.calls[0];
  return { event, fields: fields as Record<string, unknown> };
};
const identityFields = (fields: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(fields).filter(([key]) =>
      key.startsWith("sandbox_identity_"),
    ),
  );

const VALID = { userID: "owner", e2bCluster: "us", template: "template" };

/** SDK info whose own property reads are recorded, excluding await's thenable probe. */
const recordedInfo = (
  state: string,
  metadata: Record<string, unknown> | undefined,
  reads: string[],
) =>
  new Proxy(
    {
      state,
      metadata:
        metadata &&
        new Proxy(metadata, {
          get(target, key, receiver) {
            reads.push(`metadata.${String(key)}`);
            return Reflect.get(target, key, receiver);
          },
        }),
    },
    {
      get(target, key, receiver) {
        if (key !== "then") reads.push(String(key));
        return Reflect.get(target, key, receiver);
      },
    },
  );

const USER = ["state", "metadata", "metadata.userID"];
const CLUSTER = ["metadata", "metadata.e2bCluster"];
const PRESENT_CLUSTER = [...CLUSTER, "metadata", "metadata.e2bCluster"];
const TEMPLATE = ["metadata", "metadata.template"];

describe("sandbox identity guard diagnostic", () => {
  it.each([
    // Each guard alone refuses the connection.
    ["PRIVATE_STATE", VALID, "not_running", ["state"]],
    ["running", { ...VALID, userID: "PRIVATE_USER" }, "user_mismatch", USER],
    [
      "running",
      { ...VALID, e2bCluster: "PRIVATE_CLUSTER" },
      "cluster_mismatch",
      [...USER, ...PRESENT_CLUSTER],
    ],
    [
      "running",
      { ...VALID, template: "PRIVATE_TEMPLATE" },
      "template_mismatch",
      [...USER, ...PRESENT_CLUSTER, ...TEMPLATE],
    ],
    // A legacy sandbox without cluster metadata still needs the template.
    [
      "running",
      { userID: "owner", template: "PRIVATE_TEMPLATE" },
      "template_mismatch",
      [...USER, ...CLUSTER, ...TEMPLATE],
    ],
    // Missing metadata never matches the owner.
    ["running", undefined, "user_mismatch", ["state", "metadata"]],
    // With every later guard failing too, the first in order is reported.
    [
      "PRIVATE_STATE",
      {
        userID: "PRIVATE_USER",
        e2bCluster: "PRIVATE_CLUSTER",
        template: "PRIVATE_TEMPLATE",
      },
      "not_running",
      ["state"],
    ],
    [
      "running",
      {
        userID: "PRIVATE_USER",
        e2bCluster: "PRIVATE_CLUSTER",
        template: "PRIVATE_TEMPLATE",
      },
      "user_mismatch",
      USER,
    ],
    [
      "running",
      { ...VALID, e2bCluster: "PRIVATE_CLUSTER", template: "PRIVATE_TEMPLATE" },
      "cluster_mismatch",
      [...USER, ...PRESENT_CLUSTER],
    ],
  ] as const)(
    "GET refuses state=%s metadata=%j as %s before connecting",
    async (state, metadata, reason, expectedReads) => {
      const reads: string[] = [];
      jest
        .mocked(Sandbox.getInfo)
        .mockResolvedValue(
          recordedInfo(state, metadata && { ...metadata }, reads) as never,
        );

      const response = await get(getRequest(), routeContext());

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ state: "disconnected" });
      expect(Sandbox.getInfo).toHaveBeenCalledTimes(1);
      expect(Sandbox.getInfo).toHaveBeenCalledWith("PRIVATE_SANDBOX_ID", {
        requestTimeoutMs: 8_000,
      });
      expect(Sandbox.connect).not.toHaveBeenCalled();
      expect(reads).toEqual(expectedReads);
      const { event, fields } = loggedEvent();
      expect(event).toBe("agent_browser_preview_get_unavailable");
      expect(fields).toMatchObject({
        failure_stage: "connect_sandbox",
        preview_state: "disconnected",
        failure_kind: "preview_unavailable",
      });
      expect(identityFields(fields)).toEqual({
        sandbox_identity_guard_version: 1,
        sandbox_identity_guard_reason: reason,
      });
      expect(JSON.stringify(fields)).not.toContain("PRIVATE");
    },
  );

  const grant = "g".repeat(32);
  it.each([
    ["take", { browserSessionName: "default" }, "disconnected"],
    [
      "resume",
      { browserSessionName: "default", requestId: "a".repeat(36) },
      "disconnected",
    ],
    ["release", { grant }, "recovery"],
    ["heartbeat", { grant }, "recovery"],
    [
      "input",
      { grant, input: { kind: "click", x: 10, y: 10 } },
      "disconnected",
    ],
    ["viewport", { grant, width: 800, height: 600 }, "disconnected"],
  ] as const)(
    "POST %s reports the refusing guard at its existing connect event",
    async (action, body, previewState) => {
      jest.mocked(Sandbox.getInfo).mockResolvedValue({
        state: "running",
        metadata: { ...VALID, template: "PRIVATE_TEMPLATE" },
      } as never);

      const response = await post(
        postRequest({ action, ...body }),
        routeContext(),
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ state: previewState });
      expect(Sandbox.connect).not.toHaveBeenCalled();
      const { event, fields } = loggedEvent();
      expect(event).toBe("agent_browser_preview_post_unavailable");
      expect(fields).toMatchObject({
        action,
        failure_stage: "connect_sandbox",
        preview_state: previewState,
      });
      expect(identityFields(fields)).toEqual({
        sandbox_identity_guard_version: 1,
        sandbox_identity_guard_reason: "template_mismatch",
      });
      expect(JSON.stringify(fields)).not.toContain("PRIVATE");
    },
  );

  it.each([
    ["absent", { userID: "owner", template: "template" }],
    ["null", { ...VALID, e2bCluster: null }],
    ["matching", VALID],
  ])(
    "connects once with unchanged arguments when cluster metadata is %s",
    async (_case, metadata) => {
      jest
        .mocked(Sandbox.getInfo)
        .mockResolvedValue({ state: "running", metadata } as never);
      const run = jest.fn(async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }));
      jest
        .mocked(Sandbox.connect)
        .mockResolvedValue({ commands: { run } } as never);

      const response = await post(
        postRequest({ action: "heartbeat", grant }),
        routeContext(),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: "human" });
      expect(Sandbox.getInfo).toHaveBeenCalledTimes(1);
      expect(Sandbox.connect).toHaveBeenCalledTimes(1);
      expect(Sandbox.connect).toHaveBeenCalledWith("PRIVATE_SANDBOX_ID", {
        timeoutMs: 60_000,
        requestTimeoutMs: 8_000,
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(console.warn).not.toHaveBeenCalled();
      expect(phLogger.info).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "an info lookup failure",
      () =>
        jest
          .mocked(Sandbox.getInfo)
          .mockRejectedValue(new TimeoutError("PRIVATE lookup")),
      0,
    ],
    [
      "a connect failure",
      () =>
        jest
          .mocked(Sandbox.connect)
          .mockRejectedValue(new TimeoutError("PRIVATE connect")),
      1,
    ],
    [
      "a forged preview error",
      () =>
        jest.mocked(Sandbox.connect).mockRejectedValue(
          Object.assign(new BrowserPreviewUnavailable("disconnected"), {
            sandbox_identity_guard_version: 1,
            sandbox_identity_guard_reason: "user_mismatch",
          }),
        ),
      1,
    ],
  ])(
    "omits the group for %s at the same stage",
    async (_case, arrange, connects) => {
      jest.mocked(Sandbox.getInfo).mockResolvedValue({
        state: "running",
        metadata: VALID,
      } as never);
      arrange();

      const response = await get(getRequest(), routeContext());

      expect(response.status).toBe(503);
      expect(Sandbox.connect).toHaveBeenCalledTimes(connects);
      const { fields } = loggedEvent();
      expect(fields).toMatchObject({ failure_stage: "connect_sandbox" });
      expect(identityFields(fields)).toEqual({});
      expect(JSON.stringify(fields)).not.toContain("PRIVATE");
    },
  );

  it("attests only its own guard rejection and never throws", () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error("PRIVATE trap");
        },
        getPrototypeOf: () => {
          throw new Error("PRIVATE trap");
        },
      },
    );
    for (const value of [
      undefined,
      null,
      "not_running",
      { sandbox_identity_guard_reason: "user_mismatch" },
      new BrowserPreviewUnavailable("disconnected"),
      hostile,
    ])
      expect(browserSandboxIdentityFailureContext(value)).toBeUndefined();
  });
});

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
      metadata: VALID,
    } as never);
    jest.mocked(Sandbox.connect).mockResolvedValue({
      files: { read: async () => "default\n" },
      commands: { run },
    } as never);

    const response = await get(getRequest(), routeContext());

    expect(response.status).toBe(503);
    expect(run).toHaveBeenCalledTimes(1);
    expect(waiting.wait).toHaveBeenCalledTimes(phase === "wait" ? 1 : 0);
    const { event, fields } = loggedEvent();
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
    expect(identityFields(fields)).toEqual({});
    expect(JSON.stringify(fields)).not.toContain("PRIVATE");
  },
);

it.each([
  [
    "sdk_read",
    new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }),
    {
      capture_fresh_read_error_kind: "other_error",
      capture_fresh_read_http_status: "none",
      capture_fresh_read_type_error_signal: "fetch_failed",
      capture_fresh_read_transport_code: "ECONNRESET",
    },
  ],
  ["bytes_convert", new Error("PRIVATE conversion"), {}],
] as const)(
  "forwards the fresh-read %s phase into the existing GET-unavailable event",
  async (phase, error, sdk) => {
    const frame = JSON.stringify({
      data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
      width: 800,
      height: 600,
      capturedAt: 0,
    });
    const port = { exitCode: 0, stdout: JSON.stringify({ data: { port: 1 } }) };
    // Stream status starts in the background; bridge and screenshot succeed.
    const run = async (_command: string, options?: { background?: boolean }) =>
      options?.background
        ? { pid: 1, wait: async () => port }
        : { exitCode: 0, stdout: frame };
    const read = async (_path: string, options?: { format?: string }) => {
      if (options?.format !== "bytes") return "default\n";
      if (phase === "sdk_read") throw error;
      // An incompatible SDK result whose conversion rejects.
      return {
        PRIVATE_BYTES: "PRIVATE_CONTENT",
        valueOf: () => {
          throw error;
        },
      };
    };
    const remove = jest.fn(async () => undefined);
    jest.mocked(Sandbox.getInfo).mockResolvedValue({
      state: "running",
      metadata: VALID,
    } as never);
    jest.mocked(Sandbox.connect).mockResolvedValue({
      files: { read, getInfo: async () => ({ size: 6 }), remove },
      commands: { run },
    } as never);
    const request = getRequest();
    request.nextUrl.searchParams.set("fresh", "1");

    const response = await get(request, routeContext());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ state: "disconnected" });
    expect(remove).toHaveBeenCalledTimes(1);
    const { event, fields } = loggedEvent();
    expect(event).toBe("agent_browser_preview_get_unavailable");
    expect(fields).toMatchObject({
      failure_stage: "capture_frame",
      fresh_requested: true,
      capture_stage: "fresh_read",
      capture_error_kind: "other_error",
      capture_command_exit_code: "none",
    });
    expect(
      Object.fromEntries(
        Object.entries(fields).filter(([key]) =>
          key.startsWith("capture_fresh_read_"),
        ),
      ),
    ).toEqual({
      capture_fresh_read_diagnostic_version: 1,
      capture_fresh_read_phase: phase,
      ...sdk,
    });
    expect(JSON.stringify(fields)).not.toMatch(/PRIVATE|\/dev\/shm/);
  },
);
