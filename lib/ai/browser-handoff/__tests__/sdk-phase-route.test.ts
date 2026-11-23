/**
 * The preview GET and POST routes with the actual browser-handoff server
 * helpers: only the SDK, auth, Convex and analytics boundaries are replaced.
 * Proves closed diagnostic groups reach the existing unavailable events
 * unchanged and that the sandbox identity guards still refuse connection.
 */
import type { NextRequest } from "next/server";
import { phLogger } from "@/lib/posthog/server";
import { getConvexClient } from "@/lib/db/convex-client";
import {
  CommandExitError,
  FileNotFoundError,
  NotFoundError,
  Sandbox,
  TimeoutError,
} from "@e2b/code-interpreter";
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
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn(), info: jest.fn(), flush: jest.fn() },
}));
jest.mock("@e2b/code-interpreter", () => {
  // The pinned SDK assigns each name as an own data property.
  class NotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "NotFoundError";
    }
  }
  return {
    Sandbox: { getInfo: jest.fn(), connect: jest.fn() },
    CommandExitError: class extends Error {},
    TimeoutError: class extends Error {},
    NotFoundError,
    FileNotFoundError: class extends NotFoundError {
      constructor(message: string) {
        super(message);
        this.name = "FileNotFoundError";
      }
    },
  };
});
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

const SESSION_ID = "a".repeat(32);
const ORIGIN = "https://preview.example";
const sessionRow = (overrides: Record<string, unknown> = {}) => ({
  sessionId: SESSION_ID,
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
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.mocked(getConvexClient).mockImplementation(
    () =>
      ({
        query: async () => sessionRow(),
        // Every claim, grant check, abort and finish succeeds.
        mutation: async () => true,
      }) as never,
  );
});
afterEach(() => jest.restoreAllMocks());

const routeContext = () => ({
  params: Promise.resolve({ sessionId: SESSION_ID }),
});
const getRequest = (signal?: AbortSignal) =>
  ({
    headers: new Headers(),
    nextUrl: new URL(`${ORIGIN}/api/agent/browser/${SESSION_ID}`),
    ...(signal && { signal }),
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

/**
 * A fresh capture whose status, bridge and screenshot succeed. The private
 * frame's stat, its bytes read and the cleanup are supplied by each test.
 */
const connectFreshRead = ({
  stat = async () => ({ size: 6 }),
  bytes,
  activeName = () => "default\n",
  remove = jest.fn(async () => undefined),
}: {
  stat?: () => Promise<unknown>;
  bytes: () => unknown;
  activeName?: () => string;
  remove?: jest.Mock;
}) => {
  const frame = JSON.stringify({
    data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
    width: 800,
    height: 600,
    capturedAt: 0,
  });
  const port = { exitCode: 0, stdout: JSON.stringify({ data: { port: 1 } }) };
  // Stream status starts in the background; bridge and screenshot succeed.
  const run = jest.fn(
    async (_command: string, options?: { background?: boolean }) =>
      options?.background
        ? { pid: 1, wait: async () => port }
        : { exitCode: 0, stdout: frame },
  );
  const read = jest.fn(async (_path: string, options?: { format?: string }) =>
    options?.format === "bytes" ? bytes() : activeName(),
  );
  jest.mocked(Sandbox.getInfo).mockResolvedValue({
    state: "running",
    metadata: VALID,
  } as never);
  jest.mocked(Sandbox.connect).mockResolvedValue({
    files: { read, getInfo: jest.fn(stat), remove },
    commands: { run },
  } as never);
  return {
    remove,
    bytesReads: () =>
      read.mock.calls.filter(([, options]) => options?.format === "bytes")
        .length,
    screenshots: () =>
      run.mock.calls.filter(([command]) =>
        command.includes('"action":"screenshot"'),
      ).length,
  };
};
const freshRequest = (signal?: AbortSignal) => {
  const request = getRequest(signal);
  request.nextUrl.searchParams.set("fresh", "1");
  return request;
};
const freshReadFields = (fields: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(fields).filter(([key]) =>
      key.startsWith("capture_fresh_read_"),
    ),
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
    const { remove } = connectFreshRead({
      bytes: () => {
        if (phase === "sdk_read") throw error;
        // An incompatible SDK result whose conversion rejects.
        return {
          PRIVATE_BYTES: "PRIVATE_CONTENT",
          valueOf: () => {
            throw error;
          },
        };
      },
    });

    const response = await get(freshRequest(), routeContext());

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
    expect(freshReadFields(fields)).toEqual({
      capture_fresh_read_diagnostic_version: 1,
      capture_fresh_read_phase: phase,
      ...sdk,
    });
    expect(JSON.stringify(fields)).not.toMatch(/PRIVATE|\/dev\/shm/);
  },
);

describe("passive fresh FileNotFound close confirmation", () => {
  const fileNotFound = () => new FileNotFoundError("PRIVATE preview.jpg");
  const closedRow = (overrides = {}) =>
    sessionRow({ state: "closed", runActive: false, ...overrides });

  async function freshGet({
    initial = { state: "agent", runActive: true },
    reread = async (_signal?: AbortSignal) => closedRow() as unknown,
    bytes = () => {
      throw fileNotFound();
    },
    stat,
    activeName,
    fresh = true,
    controller = new AbortController(),
  }: {
    initial?: Record<string, unknown>;
    reread?: (signal?: AbortSignal) => Promise<unknown>;
    bytes?: () => unknown;
    stat?: () => Promise<unknown>;
    activeName?: () => string;
    fresh?: boolean;
    controller?: AbortController;
  } = {}) {
    const confirm = jest.fn(
      (
        reference: unknown,
        args: Record<string, unknown>,
        signal?: AbortSignal,
      ) => reread(signal),
    );
    jest.mocked(getConvexClient).mockImplementation(
      (signal?: AbortSignal) =>
        ({
          query: async (reference: unknown, args: Record<string, unknown>) =>
            args.allowEnded
              ? confirm(reference, args, signal)
              : sessionRow(initial),
        }) as never,
    );
    const sandbox = connectFreshRead({ bytes, stat, activeName });
    const request = fresh
      ? freshRequest(controller.signal)
      : getRequest(controller.signal);
    const response = await get(request, routeContext());
    return { ...sandbox, response, confirm };
  }

  it("returns the existing 410 only when the same authorized browser is closed", async () => {
    const { response, confirm, screenshots, bytesReads, remove } =
      await freshGet();

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ state: "closed" });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      "getForBackend",
      {
        serviceKey: "test-only-service-key",
        userId: "owner",
        sessionId: SESSION_ID,
        allowEnded: true,
      },
      expect.any(AbortSignal),
    );
    expect(screenshots()).toBe(1);
    expect(bytesReads()).toBe(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(phLogger.info).not.toHaveBeenCalled();
  });

  const missingActiveName = () => {
    throw new FileNotFoundError("PRIVATE active-session");
  };

  it("returns 410 when an active-session read loses its file to confirmed closure", async () => {
    const { response, confirm, screenshots, bytesReads } = await freshGet({
      activeName: missingActiveName,
    });

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ state: "closed" });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      "getForBackend",
      {
        serviceKey: "test-only-service-key",
        userId: "owner",
        sessionId: SESSION_ID,
        allowEnded: true,
      },
      expect.any(AbortSignal),
    );
    expect(screenshots()).toBe(0);
    expect(bytesReads()).toBe(0);
    expect(phLogger.info).not.toHaveBeenCalled();
  });

  it("keeps loading when the active-session file is gone before closure is visible", async () => {
    const { response, confirm, screenshots } = await freshGet({
      activeName: missingActiveName,
      reread: async () => sessionRow({ state: "agent", runActive: true }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ state: "loading" });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screenshots()).toBe(0);
    expect(loggedEvent().fields).toMatchObject({
      failure_stage: "read_active_session",
      active_session_read_diagnostic_version: 1,
      active_session_read_error_kind: "file_not_found",
    });
  });

  /**
   * The initial selection read succeeds and a genuine fresh frame is captured;
   * only the post-capture verification read loses the file to owner cleanup.
   */
  const missingAfterCapture = () => {
    let reads = 0;
    return {
      activeNameReads: () => reads,
      activeName: () => {
        reads += 1;
        if (reads === 1) return "default\n";
        throw new FileNotFoundError("PRIVATE active-session");
      },
    };
  };
  const capturedJpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  it("returns 410 when the post-capture verification read loses its file to confirmed closure", async () => {
    const { activeName, activeNameReads } = missingAfterCapture();
    const { response, confirm, screenshots, bytesReads, remove } =
      await freshGet({ activeName, bytes: capturedJpeg });

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ state: "closed" });
    expect(activeNameReads()).toBe(2);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      "getForBackend",
      {
        serviceKey: "test-only-service-key",
        userId: "owner",
        sessionId: SESSION_ID,
        allowEnded: true,
      },
      expect.any(AbortSignal),
    );
    expect(screenshots()).toBe(1);
    expect(bytesReads()).toBe(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(phLogger.info).not.toHaveBeenCalled();
  });

  it("keeps loading at verification when the owner is still active after one guarded proof", async () => {
    const { activeName, activeNameReads } = missingAfterCapture();
    const { response, confirm, screenshots, bytesReads } = await freshGet({
      activeName,
      bytes: capturedJpeg,
      reread: async () => sessionRow({ state: "agent", runActive: true }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ state: "loading" });
    expect(activeNameReads()).toBe(2);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screenshots()).toBe(1);
    expect(bytesReads()).toBe(1);
    const { event, fields } = loggedEvent();
    expect(event).toBe("agent_browser_preview_get_unavailable");
    expect(fields).toMatchObject({
      failure_stage: "verify_active_session",
      fresh_requested: true,
      handoff_state: "agent",
      run_active: true,
      active_session_read_diagnostic_version: 1,
      active_session_read_error_kind: "file_not_found",
    });
    expect(JSON.stringify(fields)).not.toMatch(/PRIVATE|\/dev\/shm/);
  });

  it.each<[string, Parameters<typeof freshGet>[0]]>([
    ["a nonfresh request", { fresh: false, activeName: missingActiveName }],
    [
      "a human-controlled session",
      {
        initial: { state: "human", runActive: true },
        activeName: missingActiveName,
      },
    ],
    [
      "a generic not-found",
      {
        activeName: () => {
          throw new NotFoundError("PRIVATE generic");
        },
      },
    ],
  ])(
    "does not confirm a close after an active-session error in %s",
    async (_case, options) => {
      const { response, confirm } = await freshGet(options);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ state: "loading" });
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a missing or superseded row", async () => null],
    ["an active row", async () => sessionRow({ state: "agent" })],
    [
      "an inactive row still open",
      async () => sessionRow({ state: "agent", runActive: false }),
    ],
    ["another session", async () => closedRow({ sessionId: "b".repeat(32) })],
    ["another run", async () => closedRow({ runId: `run_${"b".repeat(26)}` })],
    ["another owner", async () => closedRow({ userId: "different-owner" })],
    [
      "an unavailable lookup",
      async () => {
        throw new Error("PRIVATE database failure");
      },
    ],
  ] as const)(
    "retains the 503 and its diagnostic after %s",
    async (_case, reread) => {
      const { response, confirm } = await freshGet({ reread });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ state: "disconnected" });
      expect(confirm).toHaveBeenCalledTimes(1);
      const { event, fields } = loggedEvent();
      expect(event).toBe("agent_browser_preview_get_unavailable");
      expect(fields).toMatchObject({
        capture_fresh_read_phase: "sdk_read",
        capture_fresh_read_error_kind: "file_not_found",
      });
      expect(JSON.stringify(fields)).not.toMatch(/PRIVATE|\/dev\/shm/);
    },
  );

  it.each<[string, Parameters<typeof freshGet>[0]]>([
    [
      "a human-controlled session",
      { initial: { state: "human", runActive: true } },
    ],
    ["an inactive run", { initial: { state: "agent", runActive: false } }],
    [
      "a generic not-found",
      {
        bytes: () => {
          throw new NotFoundError("PRIVATE generic error");
        },
      },
    ],
    [
      "a missing file at stat",
      {
        stat: async () => {
          throw fileNotFound();
        },
      },
    ],
    [
      "an SDK timeout",
      {
        bytes: () => {
          throw new TimeoutError("PRIVATE deadline");
        },
      },
    ],
  ])(
    "leaves %s on the original path without a reread",
    async (_case, input) => {
      const { response, confirm } = await freshGet(input);

      expect(response.status).toBe(503);
      expect(confirm).not.toHaveBeenCalled();
      expect(loggedEvent().event).toBe("agent_browser_preview_get_unavailable");
    },
  );

  it("keeps the original 503 when the request aborts during confirmation", async () => {
    const controller = new AbortController();
    const { response, confirm } = await freshGet({
      controller,
      reread: async (signal) => {
        controller.abort();
        signal?.throwIfAborted();
        return closedRow();
      },
    });

    expect(response.status).toBe(503);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][2]?.aborted).toBe(true);
  });

  it("does not reread a closed row after the request has already aborted", async () => {
    const controller = new AbortController();
    const { response, confirm } = await freshGet({
      controller,
      bytes: () => {
        controller.abort();
        throw fileNotFound();
      },
    });

    expect(response.status).toBe(503);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("GET status wait progress", () => {
  const frames = (letters: string) =>
    [...letters].map((letter) => `hp1:${letter}\n`).join("");
  /** The request JSON quoted as the helper's last command argument. */
  const requestOf = (command: string) =>
    JSON.parse(/'(\{[^']*\})'$/.exec(command)![1]) as Record<string, unknown>;
  const progressFields = (fields: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(fields).filter(([key]) => key.startsWith("capture_sdk_")),
    );

  /** A pinned-SDK-shaped handle whose own buffered stderr reads are recorded. */
  const progressHandle = (
    wait: () => Promise<unknown>,
    stderr: () => unknown,
  ) => {
    const reads = jest.fn(stderr);
    return {
      reads,
      handle: {
        pid: 1,
        wait: jest.fn(wait),
        get stderr() {
          return reads();
        },
        kill: jest.fn(),
        disconnect: jest.fn(),
      },
    };
  };
  /** Clock reads: before the start request, at acknowledgement, at rejection. */
  const clock = (...values: Array<number | (() => number)>) => {
    const now = jest.spyOn(performance, "now");
    for (const value of values)
      if (typeof value === "number") now.mockReturnValueOnce(value);
      else now.mockImplementationOnce(value);
  };
  const connect = (
    run: (command: string, options?: Record<string, unknown>) => unknown,
  ) => {
    jest.mocked(Sandbox.getInfo).mockResolvedValue({
      state: "running",
      metadata: VALID,
    } as never);
    jest.mocked(Sandbox.connect).mockResolvedValue({
      files: { read: async () => "default\n" },
      commands: { run },
    } as never);
  };
  const timeout = () =>
    new TimeoutError("PRIVATE deadline https://private.invalid/?token=PRIVATE");
  // Literal copies of the texts pinned e2b 2.52.1 appends after its private
  // transport message as `${message}: ${text}` when it builds a TimeoutError.
  const SDK_TEXTS = {
    rpc_deadline:
      "This error is likely due to exceeding 'timeoutMs' — the total time a long running request (like command execution or directory watch) can be active. It can be modified by passing 'timeoutMs' when making the request. Use '0' to disable the timeout.",
    rpc_canceled:
      "This error is likely due to exceeding 'requestTimeoutMs'. You can pass the request timeout value as an option when making the request.",
    sandbox_unavailable:
      "This error is likely due to sandbox timeout. You can modify the sandbox timeout by passing 'timeoutMs' when starting the sandbox or calling '.setTimeout' on the sandbox with the desired timeout.",
    sandbox_gone:
      "The sandbox was killed or reached its end of life while the request was in flight.",
  } as const;
  const PRIVATE_PREFIX =
    "PRIVATE [deadline_exceeded] https://private.invalid/?token=PRIVATE";
  const sdkTimeout = (
    origin: keyof typeof SDK_TEXTS,
    prefix: string = PRIVATE_PREFIX,
  ) => new TimeoutError(`${prefix}: ${SDK_TEXTS[origin]}`);
  // Neither the private prefix nor any SDK text may reach the event.
  const LEAKED = /PRIVATE|hp1|likely due|end of life|timeoutMs/;
  /** Run GET with a status wait that rejects after the given delivered stderr. */
  async function rejectedGet(error: unknown, stderr: () => unknown) {
    const { handle, reads } = progressHandle(async () => {
      throw error;
    }, stderr);
    const run = jest.fn(
      async (_command: string, _options?: Record<string, unknown>) => handle,
    );
    connect(run);
    const response = await get(getRequest(), routeContext());
    return { response, run, reads, wait: handle.wait };
  }

  it.each<[string, string]>([
    // Not proof the helper never ran: frames can be dropped or undelivered.
    ["", "none_delivered"],
    [frames("e"), "entered"],
    // Socket path initialized, before the local write-attempt boundary.
    [frames("ec"), "connecting"],
    [frames("ecw"), "write_attempted"],
    // A helper-selected disposition, not actual exit delivery.
    [frames("ecwd"), "write_deadline"],
  ])(
    "projects delivered progress %j as %s beside the unchanged SDK wait group",
    async (stderr, label) => {
      clock(1_000, 1_200, 8_100);

      const { response, run, reads } = await rejectedGet(
        timeout(),
        () => stderr,
      );

      // The existing response for an SDK status rejection.
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ state: "disconnected" });
      expect(run).toHaveBeenCalledTimes(1);
      expect(reads).toHaveBeenCalledTimes(1);
      const { event, fields } = loggedEvent();
      expect(event).toBe("agent_browser_preview_get_unavailable");
      expect(fields).toMatchObject({
        failure_stage: "capture_frame",
        capture_stage: "stream_status",
        capture_error_kind: "timeout",
        capture_command_exit_code: "none",
      });
      expect(progressFields(fields)).toEqual({
        capture_sdk_command_diagnostic_version: 1,
        capture_sdk_command_phase: "wait",
        capture_sdk_start_ack_latency: "lt1s",
        capture_sdk_wait_progress_v1: `${label}:gte7s`,
        // A TimeoutError without any pinned SDK text.
        capture_sdk_wait_timeout_origin_v1: "unclassified",
      });
      expect(JSON.stringify(fields)).not.toMatch(/PRIVATE|hp1|\/dev\/shm/);
    },
  );

  describe("SDK timeout origin", () => {
    const originOf = (fields: Record<string, unknown>) =>
      fields.capture_sdk_wait_timeout_origin_v1;

    it.each<[string, () => unknown, string]>([
      ["DeadlineExceeded", () => sdkTimeout("rpc_deadline"), "rpc_deadline"],
      ["Canceled", () => sdkTimeout("rpc_canceled"), "rpc_canceled"],
      [
        "Unavailable",
        () => sdkTimeout("sandbox_unavailable"),
        "sandbox_unavailable",
      ],
      [
        "a confirmed-gone health check",
        () => sdkTimeout("sandbox_gone"),
        "sandbox_gone",
      ],
      // The SDK's message may be empty; only the separator and text remain.
      [
        "an empty SDK message",
        () => sdkTimeout("rpc_canceled", ""),
        "rpc_canceled",
      ],
      // Only the final text counts, never one quoted inside the prefix.
      [
        "a prefix quoting another SDK text",
        () =>
          sdkTimeout(
            "rpc_deadline",
            `PRIVATE: ${SDK_TEXTS.sandbox_gone} ${SDK_TEXTS.rpc_canceled}`,
          ),
        "rpc_deadline",
      ],
    ])(
      "hints %s beside the unchanged wait group and response",
      async (_case, error, origin) => {
        clock(1_000, 1_200, 8_100);

        const { response, run, wait } = await rejectedGet(error(), () =>
          frames("ecw"),
        );

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ state: "disconnected" });
        expect(run).toHaveBeenCalledTimes(1);
        expect(wait).toHaveBeenCalledTimes(1);
        const { event, fields } = loggedEvent();
        expect(event).toBe("agent_browser_preview_get_unavailable");
        expect(fields).toMatchObject({
          failure_stage: "capture_frame",
          capture_stage: "stream_status",
          capture_error_kind: "timeout",
          capture_command_exit_code: "none",
        });
        expect(progressFields(fields)).toEqual({
          capture_sdk_command_diagnostic_version: 1,
          capture_sdk_command_phase: "wait",
          capture_sdk_start_ack_latency: "lt1s",
          capture_sdk_wait_progress_v1: "write_attempted:gte7s",
          capture_sdk_wait_timeout_origin_v1: origin,
        });
        expect(JSON.stringify(fields)).not.toMatch(LEAKED);
      },
    );

    const withMessage = (descriptor: PropertyDescriptor) =>
      Object.defineProperty(
        new TimeoutError("PRIVATE original"),
        "message",
        descriptor,
      );
    it.each<[string, () => unknown]>([
      ["a compact legacy timeout", () => new TimeoutError("PRIVATE timeout")],
      [
        "no own message",
        () => new (TimeoutError as unknown as new () => Error)(),
      ],
      [
        "the SDK text without its separator",
        () => new TimeoutError(`PRIVATE ${SDK_TEXTS.rpc_deadline}`),
      ],
      [
        "a truncated SDK text",
        () =>
          new TimeoutError(`PRIVATE: ${SDK_TEXTS.sandbox_gone.slice(0, -1)}`),
      ],
      [
        "trailing whitespace",
        () => new TimeoutError(`PRIVATE: ${SDK_TEXTS.rpc_canceled}\n`),
      ],
      [
        "appended private text",
        () =>
          new TimeoutError(
            `PRIVATE: ${SDK_TEXTS.sandbox_unavailable} PRIVATE retry`,
          ),
      ],
      [
        "an ASCII hyphen for the SDK's em dash",
        () =>
          new TimeoutError(
            `PRIVATE: ${SDK_TEXTS.rpc_deadline.replace("—", "-")}`,
          ),
      ],
      [
        "a differently cased SDK text",
        () =>
          new TimeoutError(`PRIVATE: ${SDK_TEXTS.sandbox_gone.toUpperCase()}`),
      ],
      ["a non-string message", () => withMessage({ value: 42 })],
      // Never invoked: its exact SDK text would otherwise classify.
      [
        "an accessor message",
        () =>
          withMessage({
            get: () => `PRIVATE: ${SDK_TEXTS.rpc_deadline}`,
            configurable: true,
          }),
      ],
    ])(
      "records a TimeoutError with %s only as unclassified",
      async (_case, error) => {
        clock(1_000, 1_200, 3_900);

        const { response, run } = await rejectedGet(error(), () => "");

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ state: "disconnected" });
        expect(run).toHaveBeenCalledTimes(1);
        const { fields } = loggedEvent();
        expect(fields).toMatchObject({
          capture_error_kind: "timeout",
          capture_sdk_command_phase: "wait",
          capture_sdk_wait_progress_v1: "none_delivered:lt3s",
        });
        expect(originOf(fields)).toBe("unclassified");
        expect(JSON.stringify(fields)).not.toMatch(LEAKED);
      },
    );

    it.each<[string, () => unknown, string]>([
      [
        "another SDK error",
        () => new Error(`${PRIVATE_PREFIX}: ${SDK_TEXTS.rpc_deadline}`),
        "other_error",
      ],
      [
        "a thrown string",
        () => `${PRIVATE_PREFIX}: ${SDK_TEXTS.sandbox_gone}`,
        "thrown_value",
      ],
    ])(
      "omits the hint for %s carrying an exact SDK text",
      async (_case, error, kind) => {
        clock(1_000, 1_200, 1_900);

        const { response } = await rejectedGet(error(), () => frames("ec"));

        expect(response.status).toBe(503);
        const { fields } = loggedEvent();
        expect(fields).toMatchObject({
          capture_error_kind: kind,
          capture_sdk_command_phase: "wait",
          capture_sdk_wait_progress_v1: "connecting:lt1s",
        });
        expect(fields).not.toHaveProperty("capture_sdk_wait_timeout_origin_v1");
        expect(JSON.stringify(fields)).not.toMatch(LEAKED);
      },
    );

    it("omits the hint when the start request rejects", async () => {
      const run = jest.fn(async () => {
        throw sdkTimeout("rpc_deadline");
      });
      connect(run);

      const response = await get(getRequest(), routeContext());

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ state: "disconnected" });
      expect(run).toHaveBeenCalledTimes(1);
      const { fields } = loggedEvent();
      expect(progressFields(fields)).toEqual({
        capture_sdk_command_diagnostic_version: 1,
        capture_sdk_command_phase: "start",
      });
      expect(JSON.stringify(fields)).not.toMatch(LEAKED);
    });
  });

  it.each<[string, () => unknown]>([
    ["a partial trailing frame", () => frames("e") + "hp1:c"],
    ["out-of-order frames", () => frames("ce")],
    // Well-formed frames, but a sequence the helper cannot write.
    ["a success that never wrote its request", () => frames("ecs")],
    ["a contaminated prefix", () => "PRIVATE login\n" + frames("ecw")],
    ["a contaminated suffix", () => frames("ecw") + "PRIVATE warning\n"],
    ["oversized output", () => "PRIVATE ".repeat(100_000)],
  ])("records %s only as unrecognized", async (_case, stderr) => {
    clock(1_000, 1_200, 1_900);

    await rejectedGet(timeout(), stderr);

    const { fields } = loggedEvent();
    expect(fields).toHaveProperty(
      "capture_sdk_wait_progress_v1",
      "unrecognized:lt1s",
    );
    expect(JSON.stringify(fields)).not.toMatch(/PRIVATE|hp1|\/dev\/shm/);
  });

  it.each<[string, () => unknown]>([
    [
      "a throwing getter",
      () => {
        throw new Error("PRIVATE getter");
      },
    ],
    ["a non-string buffer", () => Buffer.from(frames("ecw"))],
  ])(
    "records %s as unreadable and keeps the original rejection",
    async (_case, stderr) => {
      clock(1_000, 1_200, 3_900);

      const { response } = await rejectedGet(timeout(), stderr);

      expect(response.status).toBe(503);
      const { fields } = loggedEvent();
      expect(fields).toMatchObject({
        capture_error_kind: "timeout",
        capture_sdk_command_phase: "wait",
        capture_sdk_wait_progress_v1: "unreadable:lt3s",
      });
      expect(JSON.stringify(fields)).not.toContain("PRIVATE");
    },
  );

  it.each<[string, Array<number | (() => number)>, string]>([
    ["under six seconds", [1_000, 1_100, 6_999], "lt6s"],
    ["adjacent to the SDK deadline", [1_000, 1_100, 7_999], "lt7s"],
    ["at the SDK deadline", [1_000, 1_100, 8_000], "gte7s"],
    [
      "with a rejection clock before the start",
      [1_000, 1_100, 999],
      "unmeasured",
    ],
    [
      "with a throwing rejection clock",
      [
        1_000,
        1_100,
        () => {
          throw new Error("PRIVATE clock");
        },
      ],
      "unmeasured",
    ],
  ])(
    "buckets total elapsed %s independently of acknowledgement",
    async (_case, values, bucket) => {
      clock(...values);

      await rejectedGet(timeout(), () => frames("ecw"));

      const { fields } = loggedEvent();
      expect(fields).toMatchObject({
        capture_sdk_start_ack_latency: "lt1s",
        capture_sdk_wait_progress_v1: `write_attempted:${bucket}`,
      });
    },
  );

  it("records progress for an SDK-only rejection without an exit", async () => {
    clock(1_000, 1_200, 7_500);

    await rejectedGet(
      new Error("PRIVATE Process exited without a result"),
      () => frames("ecws"),
    );

    const { fields } = loggedEvent();
    expect(fields).toMatchObject({
      capture_error_kind: "other_error",
      capture_sdk_command_phase: "wait",
      capture_sdk_wait_progress_v1: "write_success:lt7s",
    });
    expect(JSON.stringify(fields)).not.toContain("PRIVATE");
  });

  it("never reads stderr for a delivered exit", async () => {
    // The mocked SDK class; the real one takes a CommandResult.
    const Exit = CommandExitError as unknown as new (message: string) => Error;
    const { reads } = await rejectedGet(new Exit("PRIVATE exit"), () =>
      frames("ecwo"),
    );

    expect(reads).not.toHaveBeenCalled();
    const { fields } = loggedEvent();
    expect(fields).toMatchObject({ capture_error_kind: "command_exit" });
    expect(progressFields(fields)).toEqual({});
  });

  it("opts in only the GET status request, with the same start options", async () => {
    const { run } = await rejectedGet(timeout(), () => "");

    const [command, options] = run.mock.calls[0];
    expect(requestOf(command)).toEqual({
      action: "stream_status",
      owned_port: true,
      recognize_closed: true,
      observe_progress: true,
    });
    expect(options).toEqual({
      user: "root",
      timeoutMs: 7_000,
      background: true,
    });
  });

  it("neither reads stderr nor logs when the status and frame succeed", async () => {
    const frame = JSON.stringify({
      data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
      width: 800,
      height: 600,
      capturedAt: 1,
    });
    const { handle, reads } = progressHandle(
      async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ data: { port: 1 } }),
        stderr: frames("ecws"),
      }),
      () => frames("ecws"),
    );
    connect(async (_command: string, options?: Record<string, unknown>) =>
      options?.background ? handle : { exitCode: 0, stdout: frame },
    );

    const response = await get(getRequest(), routeContext());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "recovery",
      frame: { width: 800, height: 600 },
    });
    expect(reads).not.toHaveBeenCalled();
    expect(phLogger.info).not.toHaveBeenCalled();
  });

  it("leaves the POST resume status request and its wait failure unopted", async () => {
    const commands: string[] = [];
    const { handle, reads } = progressHandle(
      async () => {
        // An exact SDK text that the opted-in GET would classify.
        throw sdkTimeout("rpc_deadline");
      },
      () => frames("ecw"),
    );
    const input = {
      pid: 2,
      sendStdin: jest.fn(async () => undefined),
      closeStdin: jest.fn(async () => undefined),
      wait: jest.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };
    connect(async (command: string, options?: Record<string, unknown>) => {
      commands.push(command);
      if (options?.background) return options.stdin ? input : handle;
      return {
        exitCode: 0,
        stdout: command.includes("stream_status")
          ? JSON.stringify({ data: { port: 1 } })
          : "",
        stderr: "",
      };
    });

    const response = await post(
      postRequest({
        action: "resume",
        browserSessionName: "default",
        requestId: "a".repeat(36),
      }),
      routeContext(),
    );

    expect(response.status).toBe(503);
    expect(handle.wait).toHaveBeenCalledTimes(1);
    expect(reads).not.toHaveBeenCalled();
    const statusRequests = commands
      .filter((command) => command.includes("stream_status"))
      .map(requestOf);
    expect(statusRequests).toEqual([
      { action: "stream_status" },
      { action: "stream_status" },
    ]);
    const { event, fields } = loggedEvent();
    expect(event).toBe("agent_browser_preview_post_unavailable");
    expect(fields).toMatchObject({
      failure_stage: "capture_frame",
      capture_stage: "stream_status",
      capture_sdk_command_phase: "wait",
    });
    expect(fields).not.toHaveProperty("capture_sdk_wait_progress_v1");
    expect(fields).not.toHaveProperty("capture_sdk_wait_timeout_origin_v1");
    expect(JSON.stringify(fields)).not.toMatch(LEAKED);
  });
});
