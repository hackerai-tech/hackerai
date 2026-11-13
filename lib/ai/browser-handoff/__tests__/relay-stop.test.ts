/** @jest-environment node */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CommandExitError,
  SandboxError,
  SandboxNotFoundError,
  TimeoutError,
  type Sandbox,
} from "@e2b/code-interpreter";
import {
  BrowserPreviewUnavailable,
  browserRelayRenewFailureContext,
  browserRelayStopFailureContext,
  renewBrowserRelay,
  stopBrowserRelays,
} from "../server";

jest.mock("server-only", () => ({}));
// SDK-only transitive dependency without a root link; keep the real error types.
jest.mock("dockerfile-ast", () => ({}), { virtual: true });
jest.mock("@/lib/ai/tools/utils/e2b-cluster", () => ({
  getE2BClusterRouting: jest.fn(),
}));
jest.mock("@/lib/ai/tools/utils/sandbox-command-options", () => ({
  buildSandboxCommandOptions: () => ({ user: "root" }),
}));

const session = {
  userId: "owner",
  sandboxId: "sandbox",
  triggerRegion: null,
  directory: "/PRIVATE_SESSION",
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const grant = "PRIVATE_GRANT_".padEnd(43, "x");
const KEYS = [
  "relay_stop_command_exit_code",
  "relay_stop_diagnostic_version",
  "relay_stop_error_kind",
  "relay_stop_http_status",
];

function fakeSandbox(
  run: (command: string, options?: unknown) => Promise<unknown>,
) {
  const mock = jest.fn(run);
  return { sandbox: { commands: { run: mock } } as unknown as Sandbox, mock };
}

// Box the rejection: resolving with a hostile proxy would read its `then` trap.
async function rejectionOf(promise: Promise<unknown>): Promise<[unknown]> {
  try {
    await promise;
  } catch (error) {
    return [error];
  }
  throw new Error("Expected the stop operation to reject");
}

const privateResult = {
  exitCode: 1,
  stdout: "PRIVATE_STDOUT",
  stderr: "PRIVATE_STDERR",
  error: "PRIVATE_ERROR",
};

it.each([
  [
    "SDK command exit",
    () => new CommandExitError(privateResult),
    {
      relay_stop_error_kind: "command_exit",
      relay_stop_http_status: "none",
      relay_stop_command_exit_code: 1,
    },
  ],
  [
    "SDK command timeout",
    () => new TimeoutError("PRIVATE deadline_exceeded"),
    {
      relay_stop_error_kind: "timeout",
      relay_stop_http_status: "none",
      relay_stop_command_exit_code: "none",
    },
  ],
  [
    "finite SDK HTTP status",
    () =>
      Object.assign(new SandboxError("PRIVATE 502: body"), {
        statusCode: 502,
      }),
    {
      relay_stop_error_kind: "sandbox_error",
      relay_stop_http_status: 502,
      relay_stop_command_exit_code: "none",
    },
  ],
  [
    "missing sandbox",
    () =>
      Object.assign(new SandboxNotFoundError("PRIVATE sandbox"), {
        statusCode: 404,
      }),
    {
      relay_stop_error_kind: "sandbox_not_found",
      relay_stop_http_status: 404,
      relay_stop_command_exit_code: "none",
    },
  ],
  [
    "fetch transport failure",
    () =>
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("PRIVATE_CAUSE"), {
          code: "ECONNRESET",
        }),
      }),
    {
      relay_stop_error_kind: "other_error",
      relay_stop_http_status: "none",
      relay_stop_command_exit_code: "none",
      relay_stop_type_error_signal: "fetch_failed",
      relay_stop_transport_code: "ECONNRESET",
    },
  ],
  [
    "thrown non-error value",
    () => "PRIVATE thrown string",
    {
      relay_stop_error_kind: "thrown_value",
      relay_stop_http_status: "none",
      relay_stop_command_exit_code: "none",
    },
  ],
])(
  "keeps a %s rejection and projects only fixed stop fields",
  async (_name, make, expected) => {
    const original = make();
    const f = fakeSandbox(async () => {
      throw original;
    });
    const [caught] = await rejectionOf(stopBrowserRelays(f.sandbox, session));
    expect(caught).toBe(original);
    expect(f.mock).toHaveBeenCalledTimes(1);
    expect(f.mock.mock.calls[0][1]).toEqual({ user: "root", timeoutMs: 7000 });
    const context = browserRelayStopFailureContext(caught);
    expect(context).toEqual({ relay_stop_diagnostic_version: 1, ...expected });
    expect(JSON.stringify(context)).not.toMatch(/PRIVATE|fetch failed/);
  },
);

it.each([
  [3, 3],
  [255, 255],
  [-1, "other"],
  [256, "other"],
  [1.5, "other"],
  ["1", "other"],
  [undefined, "other"],
])(
  "keeps a returned exit %p unavailable and records only a bounded code",
  async (exitCode, expected) => {
    const f = fakeSandbox(async () => ({
      exitCode,
      stdout: "PRIVATE_STDOUT",
      stderr: "PRIVATE_STDERR",
    }));
    const [caught] = await rejectionOf(
      stopBrowserRelays(f.sandbox, session, grant),
    );
    expect(caught).toBeInstanceOf(BrowserPreviewUnavailable);
    expect(caught).toMatchObject({ state: "disconnected" });
    expect(f.mock).toHaveBeenCalledTimes(1);
    const context = browserRelayStopFailureContext(caught);
    expect(context).toEqual({
      relay_stop_diagnostic_version: 1,
      relay_stop_error_kind: "command_exit",
      relay_stop_http_status: "none",
      relay_stop_command_exit_code: expected,
    });
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
    // The renew projection keeps its own returned-exit store.
    expect(browserRelayRenewFailureContext(caught)).toMatchObject({
      relay_renew_error_kind: "other_error",
      relay_renew_command_exit_code: "none",
    });
  },
);

it("resolves a successful stop without another sandbox operation", async () => {
  const f = fakeSandbox(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await expect(
    stopBrowserRelays(f.sandbox, session, grant),
  ).resolves.toBeUndefined();
  expect(f.mock).toHaveBeenCalledTimes(1);
  expect(f.mock.mock.calls[0][1]).toEqual({ user: "root", timeoutMs: 7000 });
});

it("does not label other unavailable failures as a stop exit", async () => {
  const f = fakeSandbox(async () => ({ exitCode: 42, stdout: "", stderr: "" }));
  const [renewal] = await rejectionOf(
    renewBrowserRelay(f.sandbox, session, grant, Date.now() + 25_000),
  );
  expect(browserRelayStopFailureContext(renewal)).toEqual({
    relay_stop_diagnostic_version: 1,
    relay_stop_error_kind: "preview_unavailable",
    relay_stop_http_status: "none",
    relay_stop_command_exit_code: "none",
  });
  expect(
    browserRelayStopFailureContext(new BrowserPreviewUnavailable("loading")),
  ).toMatchObject({ relay_stop_command_exit_code: "none" });
});

it("never invokes SDK result, exit or status accessors", async () => {
  const reads: string[] = [];
  const accessor = (name: string, value: unknown) => ({
    get() {
      reads.push(name);
      return value;
    },
  });
  const viaResult = new CommandExitError(privateResult);
  Object.defineProperty(viaResult, "result", accessor("result", privateResult));
  const viaExit = new CommandExitError(privateResult);
  Object.defineProperty(
    viaExit,
    "result",
    Object.assign(Object.getOwnPropertyDescriptor(viaExit, "result")!, {
      value: Object.defineProperty({}, "exitCode", accessor("exitCode", 1)),
    }),
  );
  const viaStatus = new SandboxError("PRIVATE");
  Object.defineProperty(viaStatus, "statusCode", accessor("statusCode", 502));
  for (const original of [viaResult, viaExit, viaStatus]) {
    const f = fakeSandbox(async () => {
      throw original;
    });
    const [caught] = await rejectionOf(stopBrowserRelays(f.sandbox, session));
    expect(caught).toBe(original);
    const context = browserRelayStopFailureContext(caught);
    expect(Object.keys(context).sort()).toEqual(KEYS);
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  }
  expect(browserRelayStopFailureContext(viaResult)).toMatchObject({
    relay_stop_error_kind: "command_exit",
    relay_stop_command_exit_code: "other",
  });
  expect(browserRelayStopFailureContext(viaStatus)).toMatchObject({
    relay_stop_http_status: "none",
  });
  expect(reads).toEqual([]);
});

it("keeps a hostile proxy rejection and returns a fixed unreadable projection", async () => {
  const trap = () => {
    throw new Error("PRIVATE trap");
  };
  const original = new Proxy(new CommandExitError(privateResult), {
    get: trap,
    getOwnPropertyDescriptor: trap,
    getPrototypeOf: trap,
    has: trap,
    ownKeys: trap,
  });
  const f = fakeSandbox(async () => {
    throw original;
  });
  const [caught] = await rejectionOf(stopBrowserRelays(f.sandbox, session));
  expect(caught === original).toBe(true);
  let context: unknown;
  expect(() => {
    context = browserRelayStopFailureContext(caught);
  }).not.toThrow();
  expect(context).toEqual({
    relay_stop_diagnostic_version: 1,
    relay_stop_error_kind: "unreadable",
    relay_stop_http_status: "none",
    relay_stop_command_exit_code: "other",
  });
});

describe("with the actual relay stop program", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "handoff-relay-stop-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Executes the wrapper's exact shell command, as the E2B process API would.
  const localSandbox = (sdkThrowsOnExit: boolean) =>
    fakeSandbox(async (command) => {
      const child = spawn("/bin/sh", ["-c", command], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const [exitCode] = await once(child, "close");
      const result = { exitCode, stdout, stderr };
      if (sdkThrowsOnExit && exitCode !== 0) throw new CommandExitError(result);
      return result;
    });

  it("drains a closed relay and resolves", async () => {
    const relay = join(root, `relay-${"a".repeat(24)}`);
    await mkdir(relay);
    await writeFile(join(relay, "closed"), "1");
    const f = localSandbox(true);
    await expect(
      stopBrowserRelays(f.sandbox, { ...session, directory: root }),
    ).resolves.toBeUndefined();
    expect(await readFile(join(relay, "revoked"), "utf8")).toBe("1");
    expect(f.mock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["SDK command exit", true],
    ["returned exit", false],
  ])("projects a failed drain as %s code 1", async (_name, sdkThrowsOnExit) => {
    // An unwritable relay entry makes the program's own failure path exit 1.
    await writeFile(join(root, `relay-${"b".repeat(24)}`), "");
    const f = localSandbox(sdkThrowsOnExit);
    const [caught] = await rejectionOf(
      stopBrowserRelays(f.sandbox, { ...session, directory: root }),
    );
    expect(caught).toBeInstanceOf(
      sdkThrowsOnExit ? CommandExitError : BrowserPreviewUnavailable,
    );
    expect(f.mock).toHaveBeenCalledTimes(1);
    const context = browserRelayStopFailureContext(caught);
    expect(context).toEqual({
      relay_stop_diagnostic_version: 1,
      relay_stop_error_kind: "command_exit",
      relay_stop_http_status: "none",
      relay_stop_command_exit_code: 1,
    });
    expect(JSON.stringify(context)).not.toContain(root);
  });
});
