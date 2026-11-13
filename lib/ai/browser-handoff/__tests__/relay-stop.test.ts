/** @jest-environment node */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compileFunction } from "node:vm";
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
import { RELAY_STOP_PROGRAM } from "../relay-program";

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
const invalidReceipt = {
  relay_stop_receipt_version: 1,
  relay_stop_receipt_status: "invalid",
};
const deadlineReceipt = "relay-stop-receipt/1 0 0 0 1 0\n";
const v2DeadlineReceipt = "relay-stop-receipt/2 0 0 0 1 0 3 2\n";
const recordedDeadline = {
  relay_stop_receipt_version: 1,
  relay_stop_receipt_status: "recorded",
  relay_stop_first_failure: "drain_deadline",
  relay_stop_drain_deadline_count: 1,
  relay_stop_filesystem_failure_count: 0,
};
const commandExit = {
  relay_stop_diagnostic_version: 1,
  relay_stop_error_kind: "command_exit",
  relay_stop_http_status: "none",
  relay_stop_command_exit_code: 1,
};

it.each([
  [
    "SDK command exit",
    () => new CommandExitError(privateResult),
    {
      relay_stop_error_kind: "command_exit",
      relay_stop_http_status: "none",
      relay_stop_command_exit_code: 1,
      ...invalidReceipt,
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
      ...invalidReceipt,
    });
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
    // The renew projection keeps its own returned-exit store.
    expect(browserRelayRenewFailureContext(caught)).toMatchObject({
      relay_renew_error_kind: "other_error",
      relay_renew_command_exit_code: "none",
    });
  },
);

describe("stop receipt projection", () => {
  const absent = {
    relay_stop_receipt_version: 1,
    relay_stop_receipt_status: "absent",
  };
  const valid = "relay-stop-receipt/1 1 2 3 1 1";
  it.each([
    ["legacy empty output", 1, "", absent],
    ["missing output", 1, undefined, absent],
    ["a drain deadline", 1, deadlineReceipt, recordedDeadline],
    [
      "a filesystem stage",
      1,
      valid,
      {
        relay_stop_receipt_version: 1,
        relay_stop_receipt_status: "recorded",
        relay_stop_first_failure: "filesystem",
        relay_stop_first_filesystem_stage: "write_revoked",
        relay_stop_first_filesystem_code: "not_directory",
        relay_stop_drain_deadline_count: 1,
        relay_stop_filesystem_failure_count: 1,
      },
    ],
    [
      "a version 2 drain deadline",
      1,
      v2DeadlineReceipt,
      {
        ...recordedDeadline,
        relay_stop_receipt_version: 2,
        relay_stop_first_deadline_alive_branch: "signal_error",
        relay_stop_first_deadline_alive_code: "permission",
      },
    ],
    [
      "the longest version 2 receipt",
      1,
      "relay-stop-receipt/2 1 4 8 16 16 5 8\n",
      {
        relay_stop_receipt_version: 2,
        relay_stop_receipt_status: "recorded",
        relay_stop_first_failure: "filesystem",
        relay_stop_first_filesystem_stage: "write_closed",
        relay_stop_first_filesystem_code: "other",
        relay_stop_drain_deadline_count: 16,
        relay_stop_filesystem_failure_count: 16,
        relay_stop_first_deadline_alive_branch: "linux_cmdline_error",
        relay_stop_first_deadline_alive_code: "other",
      },
    ],
    [
      "a version 2 non-error alive branch",
      1,
      "relay-stop-receipt/2 0 0 0 2 0 4 0",
      {
        ...recordedDeadline,
        relay_stop_receipt_version: 2,
        relay_stop_drain_deadline_count: 2,
        relay_stop_first_deadline_alive_branch: "linux_matching_cmdline",
      },
    ],
    [
      "a version 2 receipt without a deadline",
      1,
      "relay-stop-receipt/2 1 1 1 0 1 0 0",
      {
        relay_stop_receipt_version: 2,
        relay_stop_receipt_status: "recorded",
        relay_stop_first_failure: "filesystem",
        relay_stop_first_filesystem_stage: "scan_root",
        relay_stop_first_filesystem_code: "missing",
        relay_stop_drain_deadline_count: 0,
        relay_stop_filesystem_failure_count: 1,
      },
    ],
    [
      "a version 1 receipt with an extra newline",
      1,
      deadlineReceipt + "\n",
      invalidReceipt,
    ],
    [
      "a version 2 receipt with an extra newline",
      1,
      v2DeadlineReceipt + "\n",
      invalidReceipt,
    ],
    ["a receipt with another exit", 3, deadlineReceipt, invalidReceipt],
    [
      "a version 2 receipt with another exit",
      3,
      v2DeadlineReceipt,
      invalidReceipt,
    ],
    [
      "a version 2 receipt without alive fields",
      1,
      "relay-stop-receipt/2 0 0 0 1 0",
      invalidReceipt,
    ],
    [
      "a version 1 receipt with alive fields",
      1,
      "relay-stop-receipt/1 0 0 0 1 0 1 1",
      invalidReceipt,
    ],
    [
      "an unknown receipt version",
      1,
      "relay-stop-receipt/3 0 0 0 1 0 1 1",
      invalidReceipt,
    ],
    [
      "a deadline without an alive branch",
      1,
      "relay-stop-receipt/2 0 0 0 1 0 0 0",
      invalidReceipt,
    ],
    [
      "an alive branch without a deadline",
      1,
      "relay-stop-receipt/2 1 2 3 0 1 6 0",
      invalidReceipt,
    ],
    [
      "an error branch without a code",
      1,
      "relay-stop-receipt/2 0 0 0 1 0 1 0",
      invalidReceipt,
    ],
    [
      "a code on a non-error branch",
      1,
      "relay-stop-receipt/2 0 0 0 1 0 6 1",
      invalidReceipt,
    ],
    [
      "an unknown alive branch",
      1,
      "relay-stop-receipt/2 0 0 0 1 0 7 0",
      invalidReceipt,
    ],
    [
      "an unknown alive code",
      1,
      "relay-stop-receipt/2 0 0 0 1 0 1 9",
      invalidReceipt,
    ],
    [
      "an extra alive field",
      1,
      "relay-stop-receipt/2 0 0 0 1 0 1 1 1",
      invalidReceipt,
    ],
    [
      "a version 2 deadline with a stage",
      1,
      "relay-stop-receipt/2 0 2 3 1 0 1 1",
      invalidReceipt,
    ],
    ["a truncated receipt", 1, "relay-stop-receipt/1 1 2", invalidReceipt],
    [
      "a deadline with a stage",
      1,
      "relay-stop-receipt/1 0 2 3 1 0",
      invalidReceipt,
    ],
    [
      "a stage without a code",
      1,
      "relay-stop-receipt/1 1 2 0 0 1",
      invalidReceipt,
    ],
    ["no counted failure", 1, "relay-stop-receipt/1 0 0 0 0 0", invalidReceipt],
    [
      "a root scan beside relays",
      1,
      "relay-stop-receipt/1 1 1 1 1 1",
      invalidReceipt,
    ],
    [
      "a count over the cap",
      1,
      "relay-stop-receipt/1 0 0 0 17 0",
      invalidReceipt,
    ],
    ["a padded count", 1, "relay-stop-receipt/1 0 0 0 01 0", invalidReceipt],
    ["an unknown stage", 1, "relay-stop-receipt/1 1 5 1 0 1", invalidReceipt],
    ["two receipts", 1, `${deadlineReceipt}${deadlineReceipt}`, invalidReceipt],
    ["an extra trailing line", 1, `${deadlineReceipt}\n`, invalidReceipt],
    ["trailing text", 1, `${valid} PRIVATE_STDOUT`, invalidReceipt],
    ["leading text", 1, `PRIVATE_STDOUT\n${valid}`, invalidReceipt],
    ["an oversized output", 1, valid + "\n".repeat(100_000), invalidReceipt],
    ["arbitrary output", 1, "PRIVATE /PRIVATE_SESSION EACCES", invalidReceipt],
    ["non-string output", 1, 1, invalidReceipt],
  ])(
    "projects %s from the stop invocation's own output",
    async (_name, exitCode, stdout, expected) => {
      for (const sdkThrows of [false, true]) {
        const result = { exitCode, stdout, stderr: "PRIVATE_STDERR" };
        const f = fakeSandbox(async () => {
          if (sdkThrows) throw new CommandExitError(result as never);
          return result;
        });
        const [caught] = await rejectionOf(
          stopBrowserRelays(f.sandbox, session, grant),
        );
        expect(caught).toBeInstanceOf(
          sdkThrows ? CommandExitError : BrowserPreviewUnavailable,
        );
        expect(f.mock).toHaveBeenCalledTimes(1);
        const context = browserRelayStopFailureContext(caught);
        expect(context).toEqual({
          relay_stop_diagnostic_version: 1,
          relay_stop_error_kind: "command_exit",
          relay_stop_http_status: "none",
          relay_stop_command_exit_code: exitCode,
          ...expected,
        });
        expect(JSON.stringify(context)).not.toMatch(/PRIVATE|EACCES/);
      }
    },
  );

  it("ignores receipts that did not come from a stop invocation", async () => {
    const result = { exitCode: 1, stdout: deadlineReceipt, stderr: "" };
    expect(
      browserRelayStopFailureContext(new CommandExitError(result)),
    ).not.toHaveProperty("relay_stop_receipt_version");
    const f = fakeSandbox(async () => result);
    const [renewal] = await rejectionOf(
      renewBrowserRelay(f.sandbox, session, grant, Date.now() + 25_000),
    );
    expect(browserRelayStopFailureContext(renewal)).not.toHaveProperty(
      "relay_stop_receipt_version",
    );
  });

  it("reports hostile returned results as unreadable without reading accessors", async () => {
    const reads: string[] = [];
    const viaGetter = Object.defineProperty({ exitCode: 1 }, "stdout", {
      get() {
        reads.push("stdout");
        return deadlineReceipt;
      },
    });
    const viaProxy = new Proxy(
      { exitCode: 1, stdout: deadlineReceipt },
      {
        getOwnPropertyDescriptor() {
          throw new Error("PRIVATE trap");
        },
      },
    );
    for (const returned of [viaGetter, viaProxy]) {
      const f = fakeSandbox(async () => returned);
      const [caught] = await rejectionOf(
        stopBrowserRelays(f.sandbox, session, grant),
      );
      expect(caught).toBeInstanceOf(BrowserPreviewUnavailable);
      expect(caught).toMatchObject({ state: "disconnected" });
      expect(browserRelayStopFailureContext(caught)).toEqual({
        relay_stop_diagnostic_version: 1,
        relay_stop_error_kind: "command_exit",
        relay_stop_http_status: "none",
        relay_stop_command_exit_code: 1,
        relay_stop_receipt_version: 1,
        relay_stop_receipt_status: "unreadable",
      });
    }
    expect(reads).toEqual([]);
  });

  it("keeps the original SDK error when its result descriptor traps", async () => {
    const original = new CommandExitError({
      exitCode: 1,
      stdout: deadlineReceipt,
      stderr: "",
    });
    const hostile = new Proxy(original, {
      getOwnPropertyDescriptor() {
        throw new Error("PRIVATE trap");
      },
    });
    const f = fakeSandbox(async () => {
      throw hostile;
    });
    const [caught] = await rejectionOf(stopBrowserRelays(f.sandbox, session));
    expect(caught === hostile).toBe(true);
    const context = browserRelayStopFailureContext(caught);
    expect(context).toMatchObject({
      relay_stop_receipt_version: 1,
      relay_stop_receipt_status: "unreadable",
    });
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  });
});

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
    expect(Object.keys(context).sort()).toEqual(
      original === viaStatus
        ? KEYS
        : [
            ...KEYS,
            "relay_stop_receipt_status",
            "relay_stop_receipt_version",
          ].sort(),
    );
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  }
  expect(browserRelayStopFailureContext(viaResult)).toMatchObject({
    relay_stop_error_kind: "command_exit",
    relay_stop_command_exit_code: "other",
    relay_stop_receipt_status: "unreadable",
  });
  expect(browserRelayStopFailureContext(viaExit)).toMatchObject({
    relay_stop_receipt_status: "unreadable",
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

  // A missing pid file stays alive under the existing permissive rule.
  const neverClosedRelay = async (name: string) => {
    const relay = join(root, name);
    await mkdir(relay);
    return relay;
  };

  it("drains closed and dead relays and resolves without a receipt", async () => {
    const closed = join(root, `relay-${"a".repeat(24)}`);
    await mkdir(closed);
    await writeFile(join(closed, "closed"), "1");
    const dead = join(root, `relay-${"c".repeat(24)}`);
    await mkdir(dead);
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(exited, "exit");
    await writeFile(join(dead, "pid"), String(exited.pid));
    const f = localSandbox(true);
    await expect(
      stopBrowserRelays(f.sandbox, { ...session, directory: root }),
    ).resolves.toBeUndefined();
    for (const relay of [closed, dead]) {
      expect(await readFile(join(relay, "revoked"), "utf8")).toBe("1");
      expect(await readFile(join(relay, "closed"), "utf8")).toBe("1");
    }
    expect(f.mock).toHaveBeenCalledTimes(1);
    await expect(f.mock.mock.results[0].value).resolves.toMatchObject({
      exitCode: 0,
      stdout: "",
    });
  });

  it.each([
    ["SDK command exit", true],
    ["returned exit", false],
  ])(
    "classifies a failed revocation write as %s code 1",
    async (_name, sdkThrowsOnExit) => {
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
        ...commandExit,
        relay_stop_receipt_version: 2,
        relay_stop_receipt_status: "recorded",
        relay_stop_first_failure: "filesystem",
        relay_stop_first_filesystem_stage: "write_revoked",
        relay_stop_first_filesystem_code: "not_directory",
        relay_stop_drain_deadline_count: 0,
        relay_stop_filesystem_failure_count: 1,
      });
      expect(JSON.stringify(context)).not.toContain(root);
    },
  );

  it("classifies an unreadable session root as a scan failure", async () => {
    const f = localSandbox(true);
    const [caught] = await rejectionOf(
      stopBrowserRelays(f.sandbox, {
        ...session,
        directory: join(root, "missing"),
      }),
    );
    expect(caught).toBeInstanceOf(CommandExitError);
    const context = browserRelayStopFailureContext(caught);
    expect(context).toEqual({
      ...commandExit,
      relay_stop_receipt_version: 2,
      relay_stop_receipt_status: "recorded",
      relay_stop_first_failure: "filesystem",
      relay_stop_first_filesystem_stage: "scan_root",
      relay_stop_first_filesystem_code: "missing",
      relay_stop_drain_deadline_count: 0,
      relay_stop_filesystem_failure_count: 1,
    });
    expect(JSON.stringify(context)).not.toContain(root);
  });

  it("classifies the selected grant's unchanged drain deadline", async () => {
    const digest = createHash("sha256").update(grant).digest("hex");
    const selected = await neverClosedRelay(`relay-${digest.slice(0, 24)}`);
    // The grant-scoped stop never scans or counts this broken sibling.
    await writeFile(join(root, `relay-${"b".repeat(24)}`), "");
    const f = localSandbox(false);
    const started = Date.now();
    const [caught] = await rejectionOf(
      stopBrowserRelays(f.sandbox, { ...session, directory: root }, grant),
    );
    // The existing 100 x 50 ms close wait ran before the failure.
    expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
    expect(caught).toBeInstanceOf(BrowserPreviewUnavailable);
    expect(f.mock).toHaveBeenCalledTimes(1);
    expect(await readFile(join(selected, "revoked"), "utf8")).toBe("1");
    await expect(readFile(join(selected, "closed"))).rejects.toThrow();
    const context = browserRelayStopFailureContext(caught);
    expect(context).toEqual({
      ...commandExit,
      ...recordedDeadline,
      relay_stop_receipt_version: 2,
      relay_stop_first_deadline_alive_branch: "pid_read_error",
      relay_stop_first_deadline_alive_code: "missing",
    });
    expect(JSON.stringify(context)).not.toContain(root);
  }, 15_000);

  it("keeps an all-relay failure and reports its first failure with aggregate counts", async () => {
    const closed = join(root, `relay-${"a".repeat(24)}`);
    await mkdir(closed);
    await writeFile(join(closed, "closed"), "1");
    await writeFile(join(root, `relay-${"b".repeat(24)}`), "");
    const waiting = await neverClosedRelay(`relay-${"d".repeat(24)}`);
    const f = localSandbox(true);
    const [caught] = await rejectionOf(
      stopBrowserRelays(f.sandbox, { ...session, directory: root }),
    );
    expect(caught).toBeInstanceOf(CommandExitError);
    expect(f.mock).toHaveBeenCalledTimes(1);
    // Other relays still receive their permanent tombstones.
    expect(await readFile(join(closed, "revoked"), "utf8")).toBe("1");
    expect(await readFile(join(waiting, "revoked"), "utf8")).toBe("1");
    // The deadline's alive branch is kept beside an earlier filesystem failure.
    expect(browserRelayStopFailureContext(caught)).toEqual({
      ...commandExit,
      relay_stop_receipt_version: 2,
      relay_stop_receipt_status: "recorded",
      relay_stop_first_failure: "filesystem",
      relay_stop_first_filesystem_stage: "write_revoked",
      relay_stop_first_filesystem_code: "not_directory",
      relay_stop_drain_deadline_count: 1,
      relay_stop_filesystem_failure_count: 1,
      relay_stop_first_deadline_alive_branch: "pid_read_error",
      relay_stop_first_deadline_alive_code: "missing",
    });
  }, 15_000);
});

describe("relay stop program at its syscall boundary", () => {
  const ROOT = "/PRIVATE_ROOT";
  const A = `relay-${"a".repeat(24)}`;
  const B = `relay-${"b".repeat(24)}`;
  const C = `relay-${"c".repeat(24)}`;
  const errno = (code: string) =>
    Object.assign(new Error("PRIVATE_ERRNO"), { code });
  const missingPid = () => {
    throw errno("ENOENT");
  };
  type Boundary = {
    platform?: string;
    relays: Record<string, { pid?: () => string; revoked?: () => void }>;
    kill?: (pid: number) => void;
    cmdline?: (path: string) => string;
  };

  // Runs the actual program source with only its fs, signal and timer
  // boundaries replaced, and tallies every boundary operation it performs.
  async function runStopProgram({
    platform = "darwin",
    relays,
    kill = () => {},
    cmdline,
  }: Boundary) {
    const ops: string[] = [];
    let stdout = "";
    let onExit: ((code: number) => void) | undefined;
    const locate = (path: string) => {
      const [name, leaf = "dir"] = path.slice(ROOT.length + 1).split("/");
      return { relay: relays[name], leaf };
    };
    const fs = {
      readdirSync: () => {
        ops.push("readdir");
        return Object.keys(relays);
      },
      existsSync: (path: string) => {
        const { leaf } = locate(path);
        ops.push(`exists ${leaf}`);
        return leaf === "dir";
      },
      writeFileSync: (path: string) => {
        const { relay, leaf } = locate(path);
        ops.push(`write ${leaf}`);
        if (leaf === "revoked") relay.revoked?.();
      },
      readFileSync: (path: string) => {
        if (path.startsWith("/proc/")) {
          ops.push("read cmdline");
          if (!cmdline) throw new Error("Unexpected cmdline read");
          return cmdline(path);
        }
        const { relay, leaf } = locate(path);
        ops.push(`read ${leaf}`);
        return (relay.pid ?? missingPid)();
      },
      writeSync: (fd: number, text: string) => {
        ops.push(`writeSync ${fd}`);
        stdout += text;
      },
    };
    const program = {
      argv: [process.execPath, ROOT],
      platform,
      exitCode: undefined as number | undefined,
      kill: (pid: number, signal: number) => {
        ops.push(`kill ${signal}`);
        kill(pid);
      },
      on: (event: string, listener: (code: number) => void) => {
        if (event === "exit") onExit = listener;
      },
    };
    const sleep = (resolve: () => void, ms: number) => {
      ops.push(`sleep ${ms}`);
      resolve();
    };
    compileFunction(RELAY_STOP_PROGRAM, ["require", "process", "setTimeout"])(
      (id: string) => {
        if (id !== "node:fs") throw new Error(`Unexpected module ${id}`);
        return fs;
      },
      program,
      sleep,
    );
    // Every boundary settles synchronously, so the program completes within
    // microtasks that drain before this macrotask.
    await new Promise((resolve) => setImmediate(resolve));
    const exitCode = program.exitCode ?? 0;
    onExit?.(exitCode);
    const counts: Record<string, number> = {};
    for (const op of ops) counts[op] = (counts[op] ?? 0) + 1;
    return { exitCode, stdout, counts };
  }

  async function project(result: { exitCode: number; stdout: string }) {
    const f = fakeSandbox(async () => ({ ...result, stderr: "" }));
    const [caught] = await rejectionOf(
      stopBrowserRelays(f.sandbox, session, grant),
    );
    const context = browserRelayStopFailureContext(caught);
    expect(JSON.stringify(context)).not.toMatch(/PRIVATE|4242|relay-/);
    return context;
  }

  // The unchanged 100 x 50 ms wait for one relay that never closes.
  const deadlineOps = {
    readdir: 1,
    "exists dir": 1,
    "write revoked": 1,
    "exists closed": 100,
    "read pid": 100,
    "sleep 50": 100,
    "writeSync 1": 1,
  };
  const deadline = {
    ...commandExit,
    ...recordedDeadline,
    relay_stop_receipt_version: 2,
  };
  const matching = (path: string) =>
    path === "/proc/4242/cmdline" ? `node\0-e\0program\0${ROOT}/${A}\0` : "";

  it.each<
    [
      string,
      Omit<Boundary, "relays"> & { pid?: () => string },
      Record<string, number>,
      string,
      string | undefined,
    ]
  >([
    ["a missing pid file", {}, {}, "pid_read_error", "missing"],
    [
      "a denied pid file",
      {
        pid: () => {
          throw errno("EACCES");
        },
      },
      {},
      "pid_read_error",
      "permission",
    ],
    ["an invalid pid", { pid: () => "0" }, {}, "pid_invalid", undefined],
    [
      "a refused signal",
      {
        pid: () => "4242",
        kill: () => {
          throw errno("EPERM");
        },
      },
      { "kill 0": 100 },
      "signal_error",
      "permission",
    ],
    [
      "a matching Linux cmdline",
      { platform: "linux", pid: () => "4242", cmdline: matching },
      { "kill 0": 100, "read cmdline": 100 },
      "linux_matching_cmdline",
      undefined,
    ],
    [
      "an unreadable Linux cmdline",
      {
        platform: "linux",
        pid: () => "4242",
        cmdline: () => {
          throw errno("EMFILE");
        },
      },
      { "kill 0": 100, "read cmdline": 100 },
      "linux_cmdline_error",
      "fd_limit",
    ],
    [
      "a present non-Linux process",
      { pid: () => "4242" },
      { "kill 0": 100 },
      "nonlinux_present",
      undefined,
    ],
  ])(
    "records %s as the deadline's alive branch without extra operations",
    async (_name, { pid, ...boundary }, extraOps, branch, code) => {
      const run = await runStopProgram({
        ...boundary,
        relays: { [A]: { pid } },
      });
      expect(run.exitCode).toBe(1);
      expect(run.counts).toEqual({ ...deadlineOps, ...extraOps });
      expect(await project(run)).toEqual({
        ...deadline,
        relay_stop_first_deadline_alive_branch: branch,
        ...(code === undefined
          ? {}
          : { relay_stop_first_deadline_alive_code: code }),
      });
    },
  );

  it.each<[string, Omit<Boundary, "relays">, Record<string, number>]>([
    [
      "an exited process",
      {
        kill: () => {
          throw errno("ESRCH");
        },
      },
      {},
    ],
    [
      "a reused Linux pid",
      { platform: "linux", cmdline: () => "other\0process\0" },
      { "read cmdline": 1 },
    ],
    [
      "an exited Linux process",
      {
        platform: "linux",
        cmdline: () => {
          throw errno("ENOENT");
        },
      },
      { "read cmdline": 1 },
    ],
  ])(
    "still drains %s at once with empty output",
    async (_name, boundary, extraOps) => {
      const run = await runStopProgram({
        ...boundary,
        relays: { [A]: { pid: () => "4242" } },
      });
      expect(run).toEqual({
        exitCode: 0,
        stdout: "",
        counts: {
          readdir: 1,
          "exists dir": 1,
          "write revoked": 1,
          "exists closed": 1,
          "read pid": 1,
          "kill 0": 1,
          "write closed": 1,
          ...extraOps,
        },
      });
    },
  );

  it("reports only the last check before the deadline", async () => {
    let reads = 0;
    const run = await runStopProgram({
      relays: {
        [A]: {
          pid: () => {
            if (++reads < 100) throw errno("EACCES");
            return "0";
          },
        },
      },
    });
    expect(run.counts).toEqual(deadlineOps);
    expect(await project(run)).toEqual({
      ...deadline,
      relay_stop_first_deadline_alive_branch: "pid_invalid",
    });
  });

  it("reads error codes only as the existing checks did", async () => {
    let pidCodeReads = 0;
    const pidError = Object.defineProperty(new Error("PRIVATE"), "code", {
      get() {
        pidCodeReads++;
        return "EACCES";
      },
    });
    const pidRun = await runStopProgram({
      relays: {
        [A]: {
          pid: () => {
            throw pidError;
          },
        },
      },
    });
    // The swallowed pid failure never read its code, so no getter runs.
    expect(pidCodeReads).toBe(0);
    expect(await project(pidRun)).toEqual({
      ...deadline,
      relay_stop_first_deadline_alive_branch: "pid_read_error",
      relay_stop_first_deadline_alive_code: "other",
    });

    let signalCodeReads = 0;
    const signalError = Object.defineProperty(new Error("PRIVATE"), "code", {
      get() {
        signalCodeReads++;
        return "EPERM";
      },
    });
    const signalRun = await runStopProgram({
      relays: { [A]: { pid: () => "4242" } },
      kill: () => {
        throw signalError;
      },
    });
    // One read per check, as before.
    expect(signalCodeReads).toBe(100);
    expect(await project(signalRun)).toEqual({
      ...deadline,
      relay_stop_first_deadline_alive_branch: "signal_error",
      relay_stop_first_deadline_alive_code: "permission",
    });
  });

  it("keeps a throwing signal code as the existing drain check failure", async () => {
    const run = await runStopProgram({
      relays: { [A]: { pid: () => "4242" } },
      kill: () => {
        throw Object.defineProperty(new Error("PRIVATE"), "code", {
          get() {
            throw new Error("PRIVATE getter");
          },
        });
      },
    });
    expect(run.counts).toEqual({
      readdir: 1,
      "exists dir": 1,
      "write revoked": 1,
      "exists closed": 1,
      "read pid": 1,
      "kill 0": 1,
      "writeSync 1": 1,
    });
    expect(await project(run)).toEqual({
      ...commandExit,
      relay_stop_receipt_version: 2,
      relay_stop_receipt_status: "recorded",
      relay_stop_first_failure: "filesystem",
      relay_stop_first_filesystem_stage: "drain_check",
      relay_stop_first_filesystem_code: "other",
      relay_stop_drain_deadline_count: 0,
      relay_stop_filesystem_failure_count: 1,
    });
  });

  it("keeps the first relay to reach its deadline beside other failures", async () => {
    const run = await runStopProgram({
      relays: {
        [A]: {
          revoked: () => {
            throw errno("ENOTDIR");
          },
        },
        [B]: {},
        // A later deadline cannot replace the first relay's observation.
        [C]: { pid: () => "4242" },
      },
    });
    expect(run.counts).toEqual({
      readdir: 1,
      "exists dir": 3,
      "write revoked": 3,
      "exists closed": 200,
      "read pid": 200,
      "kill 0": 100,
      "sleep 50": 200,
      "writeSync 1": 1,
    });
    expect(await project(run)).toEqual({
      ...commandExit,
      relay_stop_receipt_version: 2,
      relay_stop_receipt_status: "recorded",
      relay_stop_first_failure: "filesystem",
      relay_stop_first_filesystem_stage: "write_revoked",
      relay_stop_first_filesystem_code: "not_directory",
      relay_stop_drain_deadline_count: 2,
      relay_stop_filesystem_failure_count: 1,
      relay_stop_first_deadline_alive_branch: "pid_read_error",
      relay_stop_first_deadline_alive_code: "missing",
    });
  });
});
