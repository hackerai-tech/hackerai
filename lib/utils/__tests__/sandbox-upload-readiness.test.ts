jest.mock("server-only", () => ({}), { virtual: true });

import {
  uploadSandboxFiles,
  getSandboxUploadFailureMetadata,
  getSandboxUploadUserMessage,
} from "../sandbox-file-utils";
import { sampleAttachmentFailureMetrics } from "../sandbox-upload-readiness";
import { phLogger } from "@/lib/posthog/server";

const files = [1, 2, 3].map((index) => ({
  kind: "url" as const,
  url: `https://example.com/private-${index}?token=secret`,
  localPath: `/home/user/upload/private-${index}`,
}));
const context = {
  service: "agent-long" as const,
  requestId: "run-test",
  userId: "user-test",
  chatId: "chat-test",
};
const ok = { exitCode: 0, stdout: "", stderr: "" };

beforeEach(() => {
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(phLogger, "event").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it("stops an unhealthy batch after one probe and one reconnect, preserving the workspace", async () => {
  const run = jest
    .fn()
    .mockRejectedValue(new Error("Request handshake timed out after 5000ms"));
  const sandbox = {
    sandboxId: "preserved-workspace",
    commands: { run },
    kill: jest.fn(),
    getMetrics: jest.fn().mockResolvedValue([
      {
        cpuUsedPct: 99,
        memUsed: 900,
        memTotal: 1000,
        diskUsed: 30,
        diskTotal: 100,
      },
    ]),
  };
  const ensure = jest.fn(async () => sandbox);
  const result = await uploadSandboxFiles(files, ensure, {
    retryAfterReconnectOnTransientFailure: true,
    logContext: context,
  });
  expect(result.failedCount).toBe(3);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls.every(([command]) => command === "true")).toBe(true);
  expect(ensure).toHaveBeenCalledTimes(2);
  expect(sandbox.kill).not.toHaveBeenCalled();
  expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
    upload_failure_phase: "readiness",
    upload_failure_reason: "command_channel_failure",
    upload_retried_after_reconnect: true,
  });
  expect(phLogger.event).toHaveBeenCalledWith(
    "sandbox_attachment_reconnect",
    expect.objectContaining({
      same_sandbox: true,
      recovery_strategy: "reconnect",
    }),
  );
  expect(phLogger.event).toHaveBeenCalledWith(
    "sandbox_attachment_failure_diagnostics",
    expect.objectContaining({ cpu_used_pct: 99, memory_used_bytes: 900 }),
  );
  expect(JSON.stringify(jest.mocked(phLogger.event).mock.calls)).not.toMatch(
    /private-|secret|preserved-workspace/,
  );
});

it("stages every attachment only after the reconnected command channel proves ready", async () => {
  const first = {
    sandboxId: "same",
    commands: {
      run: jest
        .fn()
        .mockRejectedValue(
          new Error("Request handshake timed out after 5000ms"),
        ),
    },
  };
  const run = jest.fn().mockResolvedValue(ok);
  const second = { sandboxId: "same", commands: { run } };
  const ensure = jest
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second);
  const result = await uploadSandboxFiles(files, ensure, {
    retryAfterReconnectOnTransientFailure: true,
  });
  expect(result.failedCount).toBe(0);
  expect(run.mock.calls[0][0]).toBe("true");
  expect(
    run.mock.calls.filter(([command]) => command.startsWith("curl ")),
  ).toHaveLength(3);
});

it("does not reconnect or stage after Stop arrives during readiness", async () => {
  const controller = new AbortController();
  const sandbox = {
    commands: {
      run: jest.fn(async () => {
        controller.abort();
        throw controller.signal.reason;
      }),
    },
  };
  const ensure = jest.fn(async () => sandbox);
  await expect(
    uploadSandboxFiles(files, ensure, {
      signal: controller.signal,
      retryAfterReconnectOnTransientFailure: true,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
});

it.each([
  [
    "The selected computer is disconnected. Reconnect that computer to continue this task.",
    "local_command_unavailable",
    "Reconnect it in Remote Control",
  ],
  [
    "Selected connection is unavailable",
    "local_command_unavailable",
    "Reconnect it in Remote Control",
  ],
])(
  "preserves disconnected acquisition guidance: %s",
  async (message, reason, guidance) => {
    const ensure = jest.fn().mockRejectedValue(new Error(message));
    const result = await uploadSandboxFiles(files, ensure, {
      retryAfterReconnectOnTransientFailure: true,
    });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
      upload_failure_phase: "acquisition",
      upload_failure_reason: reason,
    });
    expect(getSandboxUploadUserMessage(result)).toContain(guidance);
  },
);

it.each([
  [
    "Failed to download file: curl: (6) Could not resolve host: example.com",
    "attachment_dns_failure",
    "DNS",
  ],
  [
    "Failed to download file: curl: (6) getaddrinfo() thread failed to start",
    "attachment_resource_exhausted",
    "system resources",
  ],
  [
    "No supported Windows attachment transfer client is available",
    "attachment_client_unavailable",
    "Install one",
  ],
])(
  "classifies transfer failure without a reconnect: %s",
  async (message, reason, guidance) => {
    const sandbox = {
      sandboxKind: "centrifugo",
      files: {
        downloadFromUrl: jest.fn().mockRejectedValue(new Error(message)),
      },
    };
    const ensure = jest.fn(async () => sandbox);
    const result = await uploadSandboxFiles(files, ensure, {
      retryAfterReconnectOnTransientFailure: true,
    });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
      upload_failure_reason: reason,
    });
    expect(getSandboxUploadUserMessage(result)).toContain(guidance);
  },
);

it("bounds stalled metrics and filters untrusted fields", async () => {
  jest.useFakeTimers();
  const stalled = sampleAttachmentFailureMetrics({
    getMetrics: () => new Promise(() => {}),
  } as any);
  await jest.advanceTimersByTimeAsync(1000);
  await expect(stalled).resolves.toEqual({ metrics_status: "unavailable" });
  const result = await sampleAttachmentFailureMetrics({
    getMetrics: async () => [
      {
        cpuUsedPct: 10,
        memUsed: NaN,
        diskUsed: -1,
        path: "private",
        command: "private",
      },
    ],
  } as any);
  expect(result).toEqual({ metrics_status: "available", cpu_used_pct: 10 });
  expect(jest.getTimerCount()).toBe(0);
});
