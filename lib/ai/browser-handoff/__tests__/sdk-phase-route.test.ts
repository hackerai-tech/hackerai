/**
 * The preview GET and POST routes with the actual browser-handoff server
 * helpers: only the SDK, auth, Convex and analytics boundaries are replaced.
 * Proves closed diagnostic groups reach the existing unavailable events
 * unchanged and that the sandbox identity guards still refuse connection.
 */
import type { NextRequest } from "next/server";
import { phLogger } from "@/lib/posthog/server";
import { CommandExitError, Sandbox, TimeoutError } from "@e2b/code-interpreter";
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
    return { response, run, reads };
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
      });
      expect(JSON.stringify(fields)).not.toMatch(/PRIVATE|hp1|\/dev\/shm/);
    },
  );

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
        throw timeout();
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
  });
});
