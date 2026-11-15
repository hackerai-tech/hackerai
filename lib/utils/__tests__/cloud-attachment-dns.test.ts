/** @jest-environment node */
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("../sandbox-upload-readiness", () => ({
  checkAttachmentReadiness: jest.fn(),
  sampleAttachmentFailureMetrics: jest.fn(async () => ({
    metrics_status: "unavailable",
  })),
}));

type LookupCallback = (error: Error | null, addresses?: unknown) => void;
type FakeResolver = {
  options: unknown;
  hostname?: string;
  callback?: LookupCallback;
  cancelled: boolean;
};
// The worker's resolver: each test decides how a started lookup answers.
const mockDns = {
  resolvers: [] as FakeResolver[],
  answer: (_resolver: FakeResolver) => {},
};
jest.mock("node:dns", () => ({
  Resolver: class {
    cancelled = false;
    hostname?: string;
    callback?: LookupCallback;
    constructor(readonly options: unknown) {
      mockDns.resolvers.push(this);
    }
    resolve4(hostname: string, callback: LookupCallback) {
      this.hostname = hostname;
      this.callback = callback;
      mockDns.answer(this);
    }
    cancel() {
      this.cancelled = true;
      this.callback?.(
        Object.assign(new Error("private resolver detail"), {
          code: "ECANCELLED",
        }),
      );
    }
  },
}));

import type { AnySandbox } from "@/types";
import { AttachmentCommandCleanupError } from "@/lib/ai/tools/utils/attachment-command";
import { getAttachmentDownloadFailureContext } from "@/lib/ai/tools/utils/attachment-download-diagnostics";
import { resolveCloudAttachmentDnsPin } from "../cloud-attachment-dns";
import {
  getSandboxUploadFailureMetadata,
  uploadSandboxFiles,
} from "../sandbox-file-utils";

const PUBLIC_ADDRESS = "93.184.216.34";
const PIN = `files.example.com:443:${PUBLIC_ADDRESS}`;
const file = {
  kind: "url" as const,
  url: "https://files.example.com/bucket/report.pdf?X-Amz-Signature=signed&part=1",
  localPath: "/workspace/staging/report.pdf",
};
const ok = { exitCode: 0, stdout: "", stderr: "" };
const OPEN_NETWORK = { allowOut: [], denyOut: [] };
const RESOLVING = "curl: (28) Resolving timed out after 10000 milliseconds";

const exit = (exitCode: number, stderr: string) =>
  Object.assign(new Error(`exit status ${exitCode}`), {
    name: "CommandExitError",
    exitCode,
    stdout: "",
    stderr,
  });
const answerWith = (addresses: unknown) => (resolver: FakeResolver) =>
  resolver.callback?.(null, addresses);

/** E2B-shaped workspace: ordinary curl fails as given; the pinned curl
 * settles as `pinned`. Background runs return a handle like the SDK. */
function cloudSandbox({
  failure,
  info = { network: OPEN_NETWORK },
  pinned = ok,
  onPinnedStart = () => {},
  kill = jest.fn(async () => true),
}: {
  failure: Error;
  info?: unknown;
  pinned?: typeof ok | Error | "pending";
  onPinnedStart?: () => void;
  kill?: jest.Mock<Promise<boolean>, []>;
}) {
  let pid = 100;
  const run = jest.fn(
    async (command: string, options?: { background?: boolean }) => {
      const isPinned = command.includes("--resolve");
      const outcome = !command.startsWith("curl ")
        ? ok
        : isPinned
          ? pinned
          : failure;
      if (!options?.background) {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }
      // A failure without an exit code never produced a process.
      if (outcome instanceof Error && !("exitCode" in outcome)) throw outcome;
      if (isPinned) onPinnedStart();
      return {
        pid: ++pid,
        exitCode:
          outcome === "pending"
            ? undefined
            : outcome instanceof Error
              ? (outcome as ReturnType<typeof exit>).exitCode
              : 0,
        wait: () =>
          outcome === "pending"
            ? new Promise(() => {})
            : outcome instanceof Error
              ? Promise.reject(outcome)
              : Promise.resolve(outcome),
        disconnect: async () => {},
      };
    },
  );
  const getInfo = jest.fn(async (_options?: { signal: AbortSignal }) => {
    if (info instanceof Error) throw info;
    return info;
  });
  return { sandboxId: "cloud-workspace", commands: { run, kill }, getInfo };
}

const curlCommands = (sandbox: ReturnType<typeof cloudSandbox>) =>
  sandbox.commands.run.mock.calls
    .map(([command]) => command)
    .filter((command) => command.startsWith("curl "));
const pinnedCommands = (sandbox: ReturnType<typeof cloudSandbox>) =>
  curlCommands(sandbox).filter((command) => command.includes("--resolve"));

const expectOriginalResolvingFailure = (
  result: Awaited<ReturnType<typeof uploadSandboxFiles>>,
) => {
  expect(result.failedCount).toBe(1);
  expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
    upload_failure_reason: "attachment_download_timeout",
    attachment_download_exit_code: 28,
    attachment_download_timeout_hint: "resolving",
  });
};

const dnsFallbackFields = (fields: Record<string, unknown> | undefined) =>
  Object.fromEntries(
    Object.entries(fields ?? {}).filter(([key]) =>
      key.startsWith("attachment_download_dns_fallback_"),
    ),
  );
const lastStagingFailedEvent = () =>
  jest
    .mocked(console.error)
    .mock.calls.map(([line]) =>
      typeof line === "string" && line.startsWith("{")
        ? JSON.parse(line)
        : undefined,
    )
    .filter((event) => event?.event === "sandbox_attachment_staging_failed")
    .at(-1);

/** Only the three closed fields reach the Trigger summary and staging event. */
const expectDnsFallback = (
  result: Awaited<ReturnType<typeof uploadSandboxFiles>>,
  decision: string,
  retryResult: string,
) => {
  const expected = {
    attachment_download_dns_fallback_version: 1,
    attachment_download_dns_fallback_decision: decision,
    attachment_download_dns_fallback_retry_result: retryResult,
  };
  expect(dnsFallbackFields(getSandboxUploadFailureMetadata(result))).toEqual(
    expected,
  );
  expect(dnsFallbackFields(lastStagingFailedEvent())).toEqual(expected);
};

beforeEach(() => {
  mockDns.resolvers.length = 0;
  mockDns.answer = answerWith([PUBLIC_ADDRESS]);
  for (const level of ["info", "warn", "error"] as const)
    jest.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it.each([
  ["exit 6 after its ordinary retries", 6, "curl: (6) Could not resolve host"],
  ["a resolving timeout", 28, RESOLVING],
])(
  "recovers %s with one pinned request for the same HTTPS URL",
  async (_, exitCode, stderr) => {
    jest.useFakeTimers();
    const sandbox = cloudSandbox({ failure: exit(exitCode, stderr) });
    const signal = new AbortController().signal;
    const pending = uploadSandboxFiles([file], async () => sandbox, {
      signal,
    });
    await jest.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result).toEqual({ failedCount: 0, pathRewrites: [] });
    const commands = curlCommands(sandbox);
    const ordinary = commands.slice(0, -1);
    const pinned = commands.at(-1)!;
    // Exit 6 keeps its three ordinary attempts; a timeout is not replayed.
    expect(ordinary).toHaveLength(exitCode === 6 ? 3 : 1);
    expect(pinnedCommands(sandbox)).toEqual([pinned]);
    // Only the address is new: URL, signed query, destination, timeouts and
    // certificate verification are those of the ordinary request.
    expect(pinned.replace(` --resolve '${PIN}'`, "")).toBe(ordinary[0]);
    expect(pinned).toContain(`'${file.url}'`);
    expect(pinned).not.toMatch(/--insecure|\s-k\s|--dns-servers|--proxy/);

    expect(mockDns.resolvers).toHaveLength(1);
    expect(mockDns.resolvers[0]).toMatchObject({
      options: { timeout: 2_000, tries: 1 },
      hostname: "files.example.com",
    });
    expect(sandbox.getInfo).toHaveBeenCalledTimes(1);
    expect(sandbox.getInfo).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      requestTimeoutMs: 5_000,
    });
    expect(sandbox.commands.kill).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  },
);

it.each([
  [
    "an operation timeout",
    exit(28, "curl: (28) Operation timed out after 120001 milliseconds"),
  ],
  [
    "mixed timeout wording",
    exit(28, `${RESOLVING}\ncurl: (28) Connection timed out after 10001 ms`),
  ],
  ["a TLS failure", exit(35, "curl: (35) SSL connect error")],
  [
    "an HTTP error",
    exit(22, "curl: (22) The requested URL returned error: 403"),
  ],
  [
    "a write failure",
    exit(23, "curl: (23) Failure writing output to destination"),
  ],
  [
    "a command channel timeout",
    Object.assign(new Error("[deadline_exceeded] the operation timed out"), {
      name: "TimeoutError",
    }),
  ],
  [
    "an exit known only from message text",
    new Error("curl: (6) Could not resolve host: files.example.com"),
  ],
  [
    "resolving wording known only from message text",
    Object.assign(new Error(RESOLVING), {
      name: "CommandExitError",
      exitCode: 28,
    }),
  ],
])("leaves %s to the existing handling", async (_, failure) => {
  jest.useFakeTimers();
  const sandbox = cloudSandbox({ failure });
  const pending = uploadSandboxFiles([file], async () => sandbox, {
    signal: new AbortController().signal,
  });
  await jest.advanceTimersByTimeAsync(10_000);
  const result = await pending;

  expect(result.failedCount).toBe(1);
  expect(sandbox.getInfo).not.toHaveBeenCalled();
  expect(mockDns.resolvers).toHaveLength(0);
  expect(pinnedCommands(sandbox)).toHaveLength(0);
  // Failures that never entered recovery carry no DNS fallback record.
  expect(dnsFallbackFields(getSandboxUploadFailureMetadata(result))).toEqual(
    {},
  );
});

const NOT_OPEN = "network_not_verified_open";
it.each([
  [
    "restricted egress",
    { network: { allowOut: ["a.example"], denyOut: ["0.0.0.0/0"] } },
    NOT_OPEN,
  ],
  [
    "offline egress",
    { network: { allowOut: [], denyOut: ["0.0.0.0/0"] } },
    NOT_OPEN,
  ],
  [
    "an allowlist alone",
    { network: { allowOut: ["a.example"], denyOut: [] } },
    NOT_OPEN,
  ],
  [
    "an egress proxy",
    {
      network: {
        ...OPEN_NETWORK,
        egressProxy: { address: "proxy.example:1080" },
      },
    },
    NOT_OPEN,
  ],
  [
    "egress rules",
    { network: { ...OPEN_NETWORK, rules: { "a.example": [{}] } } },
    NOT_OPEN,
  ],
  [
    "disabled internet access",
    { network: OPEN_NETWORK, allowInternetAccess: false },
    NOT_OPEN,
  ],
  // Unknown or malformed state is not verified open, not proven restricted.
  ["no network description", {}, NOT_OPEN],
  ["a malformed network description", { network: [] }, NOT_OPEN],
  [
    "malformed egress rules",
    { network: { ...OPEN_NETWORK, rules: [] } },
    NOT_OPEN,
  ],
  [
    "a malformed deny list",
    { network: { allowOut: [], denyOut: "0.0.0.0/0" } },
    NOT_OPEN,
  ],
  [
    "an unavailable network description",
    new Error("private provider detail"),
    "network_info_unavailable",
  ],
])(
  "never pins around %s and keeps the original failure",
  async (_, info, decision) => {
    const sandbox = cloudSandbox({ failure: exit(28, RESOLVING), info });
    const result = await uploadSandboxFiles([file], async () => sandbox, {
      retryAfterReconnectOnTransientFailure: true,
    });

    expectOriginalResolvingFailure(result);
    expectDnsFallback(result, decision, "not_attempted");
    expect(sandbox.getInfo).toHaveBeenCalledTimes(1);
    expect(mockDns.resolvers).toHaveLength(0);
    expect(curlCommands(sandbox)).toHaveLength(1);
  },
);

it.each([
  [
    "a plain HTTP URL",
    "http://files.example.com/bucket/report.pdf",
    {},
    "url_not_pinnable",
  ],
  [
    "a workspace without a network description",
    file.url,
    { getInfo: undefined },
    "get_info_missing",
  ],
])(
  "records a skipped pin for %s without reading the network or resolving",
  async (_, url, override, decision) => {
    const sandbox = cloudSandbox({ failure: exit(28, RESOLVING) });
    const getInfo = sandbox.getInfo;
    Object.assign(sandbox, override);
    const result = await uploadSandboxFiles(
      [{ ...file, url }],
      async () => sandbox,
    );

    expectOriginalResolvingFailure(result);
    expectDnsFallback(result, decision, "not_attempted");
    expect(getInfo).not.toHaveBeenCalled();
    expect(mockDns.resolvers).toHaveLength(0);
    expect(curlCommands(sandbox)).toHaveLength(1);
  },
);

it.each([
  ["a private address", ["10.0.0.5"]],
  ["a loopback address", ["127.0.0.1"]],
  ["a link-local metadata address", ["169.254.169.254"]],
  ["a shared carrier address", ["100.64.0.1"]],
  ["a private 172.16/12 address", ["172.31.255.254"]],
  ["a private 192.168/16 address", ["192.168.1.1"]],
  ["a documentation address", ["192.0.2.10"]],
  ["a benchmark address", ["198.18.0.1"]],
  ["a multicast address", ["224.0.0.1"]],
  ["a reserved address", ["240.0.0.1"]],
  ["the unspecified address", ["0.0.0.0"]],
  ["a public answer mixed with a private one", [PUBLIC_ADDRESS, "10.0.0.5"]],
  ["an IPv6 answer", ["2606:2800:220:1:248:1893:25c8:1946"]],
  ["text that is not an address", [`${PUBLIC_ADDRESS}' --insecure '`]],
  ["an empty answer", []],
  ["an oversized answer", Array(17).fill(PUBLIC_ADDRESS)],
  ["a malformed answer", "93.184.216.34"],
])("never pins %s and keeps the original failure", async (_, addresses) => {
  mockDns.answer = answerWith(addresses);
  const sandbox = cloudSandbox({ failure: exit(28, RESOLVING) });
  const result = await uploadSandboxFiles([file], async () => sandbox);

  expectOriginalResolvingFailure(result);
  expectDnsFallback(result, "address_not_public", "not_attempted");
  expect(mockDns.resolvers).toHaveLength(1);
  expect(curlCommands(sandbox)).toHaveLength(1);
});

it("keeps the original failure when the worker cannot resolve the host", async () => {
  mockDns.answer = (resolver) =>
    resolver.callback?.(
      Object.assign(new Error("private resolver detail"), {
        code: "ENOTFOUND",
      }),
    );
  const sandbox = cloudSandbox({ failure: exit(28, RESOLVING) });
  const result = await uploadSandboxFiles([file], async () => sandbox);

  expectOriginalResolvingFailure(result);
  expectDnsFallback(result, "resolution_unavailable", "not_attempted");
  expect(curlCommands(sandbox)).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("private resolver detail");
});

it.each([
  [
    "the network description",
    () => ({ info: new Promise(() => {}) }),
    5_000,
    "network_info_unavailable",
  ],
  ["the lookup", () => ({}), 3_000, "resolution_unavailable"],
])(
  "bounds a stalled %s, cancels it and keeps the original failure",
  async (_, stall, deadlineMs, decision) => {
    jest.useFakeTimers();
    mockDns.answer = () => {};
    const sandbox = cloudSandbox({ failure: exit(28, RESOLVING) });
    const stalled = stall() as { info?: Promise<never> };
    if (stalled.info) sandbox.getInfo.mockReturnValue(stalled.info);
    const settled = jest.fn();
    uploadSandboxFiles([file], async () => sandbox).then(settled, settled);

    await jest.advanceTimersByTimeAsync(deadlineMs - 1);
    expect(settled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expectOriginalResolvingFailure(settled.mock.calls[0][0]);
    expectDnsFallback(settled.mock.calls[0][0], decision, "not_attempted");
    expect(curlCommands(sandbox)).toHaveLength(1);
    if (stalled.info)
      expect(sandbox.getInfo.mock.calls[0][0].signal.aborted).toBe(true);
    else expect(mockDns.resolvers[0].cancelled).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it("treats a failed pinned request as final without another attempt or reconnect", async () => {
  const sandbox = cloudSandbox({
    failure: exit(28, RESOLVING),
    pinned: exit(7, "curl: (7) Failed to connect"),
  });
  const ensure = jest.fn(async () => sandbox);
  const result = await uploadSandboxFiles([file], ensure, {
    signal: new AbortController().signal,
    retryAfterReconnectOnTransientFailure: true,
  });

  expect(result.failedCount).toBe(1);
  expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
    upload_failure_reason: "attachment_transfer_failed",
    attachment_download_exit_code: 7,
  });
  // Recorded on the pinned failure that replaced the original result.
  expectDnsFallback(result, "pin_available", "nonzero");
  expect(pinnedCommands(sandbox)).toHaveLength(1);
  expect(curlCommands(sandbox)).toHaveLength(2);
  expect(ensure).toHaveBeenCalledTimes(1);
});

it.each([
  [
    "no process result",
    Object.assign(new Error("[deadline_exceeded] the operation timed out"), {
      name: "TimeoutError",
    }),
    "threw",
  ],
  [
    "an exit known only from message text",
    new Error("curl: (7) Failed to connect"),
    "unobserved",
  ],
])(
  "keeps the original failure when the pinned request yields %s",
  async (_, pinned, retryResult) => {
    const sandbox = cloudSandbox({ failure: exit(28, RESOLVING), pinned });
    const ensure = jest.fn(async () => sandbox);
    const result = await uploadSandboxFiles([file], ensure, {
      signal: new AbortController().signal,
      retryAfterReconnectOnTransientFailure: true,
    });

    expectOriginalResolvingFailure(result);
    expectDnsFallback(result, "pin_available", retryResult);
    expect(pinnedCommands(sandbox)).toHaveLength(1);
    expect(sandbox.getInfo).toHaveBeenCalledTimes(1);
    expect(mockDns.resolvers).toHaveLength(1);
    expect(ensure).toHaveBeenCalledTimes(1);
  },
);

it("cancels the lookup on Stop and starts no pinned request", async () => {
  const controller = new AbortController();
  const stop = new Error("user stopped");
  mockDns.answer = () => controller.abort(stop);
  const sandbox = cloudSandbox({ failure: exit(28, RESOLVING) });

  await expect(
    uploadSandboxFiles([file], async () => sandbox, {
      signal: controller.signal,
    }),
  ).rejects.toBe(stop);
  expect(mockDns.resolvers[0].cancelled).toBe(true);
  expect(pinnedCommands(sandbox)).toHaveLength(0);
  // Stop keeps its own reason; no DNS fallback record is forced onto it.
  expect(dnsFallbackFields(getAttachmentDownloadFailureContext(stop))).toEqual(
    {},
  );
});

it("stops while reading the network description without resolving", async () => {
  const controller = new AbortController();
  const stop = new Error("user stopped");
  const sandbox = cloudSandbox({ failure: exit(28, RESOLVING) });
  sandbox.getInfo.mockImplementation(async () => {
    controller.abort(stop);
    return new Promise(() => {});
  });

  await expect(
    uploadSandboxFiles([file], async () => sandbox, {
      signal: controller.signal,
    }),
  ).rejects.toBe(stop);
  expect(mockDns.resolvers).toHaveLength(0);
  expect(pinnedCommands(sandbox)).toHaveLength(0);
});

it("does not start a lookup when Stop arrives between the network read and lookup", async () => {
  const controller = new AbortController();
  const stop = new Error("user stopped");
  const sandbox = cloudSandbox({
    failure: exit(28, RESOLVING),
    info: {
      get network() {
        controller.abort(stop);
        return OPEN_NETWORK;
      },
    },
  });
  const onDecision = jest.fn();

  await expect(
    resolveCloudAttachmentDnsPin(
      sandbox as unknown as AnySandbox,
      file.url,
      controller.signal,
      onDecision,
    ),
  ).rejects.toBe(stop);
  expect(mockDns.resolvers).toHaveLength(0);
  expect(onDecision).not.toHaveBeenCalled();
});

it("returns the same pin when its decision observer throws", async () => {
  const sandbox = cloudSandbox({ failure: exit(28, RESOLVING) });
  const onDecision = jest.fn(() => {
    throw new Error("observer failure");
  });

  await expect(
    resolveCloudAttachmentDnsPin(
      sandbox as unknown as AnySandbox,
      file.url,
      undefined,
      onDecision,
    ),
  ).resolves.toBe(PIN);
  expect(onDecision.mock.calls).toEqual([["pin_available"]]);
  expect(sandbox.getInfo).toHaveBeenCalledTimes(1);
  expect(mockDns.resolvers).toHaveLength(1);
});

it.each([
  ["acknowledged", true],
  ["unconfirmed", false],
])(
  "kills only the pinned request on Stop when cleanup is %s",
  async (_, acknowledged) => {
    const controller = new AbortController();
    const stop = new Error("user stopped");
    const kill = jest.fn(async () => {
      if (!acknowledged) throw new Error("kill request failed");
      return true;
    });
    const sandbox = cloudSandbox({
      failure: exit(28, RESOLVING),
      pinned: "pending",
      onPinnedStart: () => queueMicrotask(() => controller.abort(stop)),
      kill,
    });

    const pending = uploadSandboxFiles([file], async () => sandbox, {
      signal: controller.signal,
    });
    if (acknowledged) await expect(pending).rejects.toBe(stop);
    else
      await expect(pending).rejects.toBeInstanceOf(
        AttachmentCommandCleanupError,
      );
    // Stopping the pinned request is not reported as a failed retry.
    const rejection = await pending.catch((error: unknown) => error);
    expect(
      dnsFallbackFields(getAttachmentDownloadFailureContext(rejection)),
    ).toEqual({});
    // The ordinary request exited on its own; only the pinned one is killed.
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(102, { requestTimeoutMs: 5_000 });
    expect(pinnedCommands(sandbox)).toHaveLength(1);
    expect(curlCommands(sandbox)).toHaveLength(2);
  },
);

it.each([
  "http://files.example.com/report.pdf",
  "https://files.example.com:8443/report.pdf",
  "https://user:secret@files.example.com/report.pdf",
  "https://93.184.216.34/report.pdf",
  "https://[2606:2800:220:1::1]/report.pdf",
  "https://FILES.example.com/report.pdf",
  "https://files.example.com\\@other.example/report.pdf",
  "https://intranet/report.pdf",
  "not a url",
])("does not pin %s", async (url) => {
  const sandbox = cloudSandbox({ failure: exit(28, RESOLVING) });
  await expect(
    resolveCloudAttachmentDnsPin(sandbox as unknown as AnySandbox, url),
  ).resolves.toBeNull();
  expect(sandbox.getInfo).not.toHaveBeenCalled();
  expect(mockDns.resolvers).toHaveLength(0);
});

it("does not pin for a sandbox that is not an E2B workspace", async () => {
  const getInfo = jest.fn(async () => ({ network: OPEN_NETWORK }));
  const onDecision = jest.fn();
  await expect(
    resolveCloudAttachmentDnsPin(
      { sandboxKind: "centrifugo", getInfo } as unknown as AnySandbox,
      file.url,
      undefined,
      onDecision,
    ),
  ).resolves.toBeNull();
  expect(getInfo).not.toHaveBeenCalled();
  expect(onDecision.mock.calls).toEqual([["sandbox_unsupported"]]);
});
