jest.mock("server-only", () => ({}), { virtual: true });

import { uploadSandboxFiles, type SandboxFile } from "../sandbox-file-utils";
import { AttachmentCommandCleanupError } from "@/lib/ai/tools/utils/attachment-command";

const file: SandboxFile = {
  kind: "url",
  url: "https://example.com/input.txt",
  localPath: "/home/user/upload/input.txt",
};
const ok = { stdout: "", stderr: "", exitCode: 0 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it("does not acquire a sandbox for an already stopped run", async () => {
  const controller = new AbortController();
  controller.abort();
  const acquire = jest.fn();
  await expect(
    uploadSandboxFiles([file], acquire, { signal: controller.signal }),
  ).rejects.toBe(controller.signal.reason);
  expect(acquire).not.toHaveBeenCalled();
});

it.each(["success", "failure"])(
  "does not transfer or retry after cancellation during acquisition (%s)",
  async (outcome) => {
    const controller = new AbortController();
    const acquisition = deferred<any>();
    const run = jest.fn();
    const acquire = jest.fn(() => acquisition.promise);
    const pending = uploadSandboxFiles([file], acquire, {
      signal: controller.signal,
      retryWithFreshSandboxOnTransientFailure: true,
    });
    controller.abort();
    if (outcome === "success")
      acquisition.resolve({ sandboxKind: "miosa", commands: { run } });
    else
      acquisition.reject(
        new Error("[deadline_exceeded] the operation timed out"),
      );
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  },
);

it("cancels an active transfer and waits for its cleanup without touching another chat", async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  const cleanup = deferred<void>();
  const run = jest.fn((_command, { signal }) => {
    started.resolve();
    return new Promise((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          void cleanup.promise.then(() => resolve({ ...ok, exitCode: 130 }));
        },
        { once: true },
      ),
    );
  });
  const sharedSandbox = {
    sandboxKind: "miosa",
    commands: { run },
    kill: jest.fn(),
  };
  const pending = uploadSandboxFiles([file], async () => sharedSandbox, {
    signal: controller.signal,
  });
  await started.promise;
  controller.abort();
  let settled = false;
  void pending.catch(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  cleanup.resolve();
  await expect(pending).rejects.toBe(controller.signal.reason);
  expect(sharedSandbox.kill).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  run.mockResolvedValueOnce(ok);
  await expect(
    uploadSandboxFiles([file], async () => sharedSandbox),
  ).resolves.toMatchObject({ failedCount: 0 });
});

it.each(["channel", "curl"])(
  "stops %s retry backoff without another attempt or sandbox refresh",
  async (failure) => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const run =
      failure === "channel"
        ? jest
            .fn()
            .mockRejectedValue(
              new Error(
                "2: [unknown] Request handshake timed out after 60000ms",
              ),
            )
        : jest.fn().mockResolvedValue({ ...ok, exitCode: 7 });
    const acquire = jest.fn(async () => ({
      sandboxKind: "miosa",
      commands: { run },
    }));
    const pending = uploadSandboxFiles([file], acquire, {
      signal: controller.signal,
      retryWithFreshSandboxOnTransientFailure: true,
    });
    void pending.catch(() => {});
    await jest.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    controller.abort();
    // Capture the actual abort reason after abort() initializes it.
    await pending.catch((error) =>
      expect(error).toBe(controller.signal.reason),
    );
    await jest.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it("does not turn mixed success and cancellation into an upload failure", async () => {
  const controller = new AbortController();
  const run = jest.fn(async () => {
    if (run.mock.calls.length === 2) {
      controller.abort();
      throw controller.signal.reason;
    }
    return ok;
  });
  const pending = uploadSandboxFiles(
    [file, { ...file, localPath: "/home/user/upload/second.txt" }],
    async () => ({ sandboxKind: "miosa", commands: { run } }),
    { signal: controller.signal },
  );
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(console.error).not.toHaveBeenCalled();
});

it("does not try a writable-path fallback after Stop", async () => {
  const controller = new AbortController();
  const run = jest.fn(async () => {
    controller.abort();
    return { ...ok, stderr: "Permission denied", exitCode: 23 };
  });
  await uploadSandboxFiles(
    [file],
    async () => ({ sandboxKind: "miosa", commands: { run } }),
    { signal: controller.signal },
  ).catch((error) => expect(error).toBe(controller.signal.reason));
  expect(run).toHaveBeenCalledTimes(1);
});

it.each(["url", "localPath"] as const)(
  "forwards cancellation to the local %s file wrapper",
  async (kind) => {
    const controller = new AbortController();
    const transfer = jest.fn(async (_source, _destination, { signal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      throw signal.reason;
    });
    const sandbox = {
      files: { downloadFromUrl: transfer, copyLocal: transfer },
    };
    const input: SandboxFile =
      kind === "url"
        ? file
        : {
            kind,
            path: "/input.txt",
            localPath: "/tmp/hackerai-upload/input.txt",
          };
    await uploadSandboxFiles([input], async () => sandbox, {
      signal: controller.signal,
    }).catch((error) => expect(error).toBe(controller.signal.reason));
    expect(transfer).toHaveBeenCalledTimes(1);
  },
);

it("preserves a failed E2B kill instead of claiming confirmed cancellation", async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  const handle = {
    pid: 42,
    wait: () => {
      started.resolve();
      return new Promise(() => {});
    },
    disconnect: jest.fn(),
  };
  const killError = new Error("Provider unavailable");
  const sandbox = {
    commands: {
      run: jest.fn(async () => handle),
      kill: jest.fn().mockRejectedValue(killError),
    },
    kill: jest.fn(),
  };
  const pending = uploadSandboxFiles([file], async () => sandbox, {
    signal: controller.signal,
  });
  await started.promise;
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(AttachmentCommandCleanupError);
  expect(sandbox.commands.kill).toHaveBeenCalledWith(42, {
    requestTimeoutMs: 5000,
  });
  expect(sandbox.kill).not.toHaveBeenCalled();
  expect(handle.disconnect).toHaveBeenCalled();
});
