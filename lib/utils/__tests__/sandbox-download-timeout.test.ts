jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("../sandbox-upload-readiness", () => ({
  checkAttachmentReadiness: jest.fn(),
  sampleAttachmentFailureMetrics: jest.fn(async () => ({
    metrics_status: "unavailable",
  })),
}));

import {
  uploadSandboxFiles,
  getSandboxUploadFailureMetadata,
} from "../sandbox-file-utils";

const file = {
  kind: "url" as const,
  url: "https://example.com/fixture.txt",
  localPath: "/home/user/upload/fixture.txt",
};

beforeEach(() => {
  jest.useFakeTimers();
  for (const level of ["info", "warn", "error"] as const)
    jest.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it("finishes a healthy download taking longer than the SDK default without replay", async () => {
  let pid = 0;
  const run = jest.fn(async (_command: string, options: any) => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const handle = {
      pid: ++pid,
      exitCode: undefined as number | undefined,
      wait: () =>
        new Promise((resolve, reject) => {
          timers.push(
            setTimeout(() => {
              handle.exitCode = 0;
              resolve({ exitCode: 0, stdout: "", stderr: "" });
            }, 70_000),
          );
          timers.push(
            setTimeout(
              () =>
                reject(
                  Object.assign(
                    new Error("[deadline_exceeded] exceeding 'timeoutMs'"),
                    { name: "TimeoutError" },
                  ),
                ),
              options?.timeoutMs ?? 60_000,
            ),
          );
        }),
      disconnect: async () => timers.forEach(clearTimeout),
    };
    return handle;
  });
  const kill = jest.fn(async () => true);
  const pending = uploadSandboxFiles(
    [file],
    async () => ({ commands: { run, kill } }),
    { signal: new AbortController().signal },
  );
  await jest.advanceTimersByTimeAsync(400_000);
  expect(await pending).toMatchObject({ failedCount: 0 });
  expect(run).toHaveBeenCalledTimes(1);
  expect(kill).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it("reports an exhausted transfer deadline without reconnecting the workspace", async () => {
  const run = jest.fn(async () => {
    throw Object.assign(new Error("curl: (28) Operation timed out"), {
      exitCode: 28,
      stderr: "curl: (28) Operation timed out",
    });
  });
  const ensure = jest.fn(async () => ({ commands: { run } }));
  const result = await uploadSandboxFiles([file], ensure, {
    retryAfterReconnectOnTransientFailure: true,
  });
  expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
    upload_failure_reason: "attachment_download_timeout",
  });
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(1);
});
