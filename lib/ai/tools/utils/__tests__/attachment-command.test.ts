import { runAttachmentCommand } from "../attachment-command";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("kills only the late E2B process when Stop arrives during startup", async () => {
  const controller = new AbortController();
  const start = deferred<any>();
  const killed = deferred<boolean>();
  const exited = deferred<any>();
  const handle = {
    pid: 101,
    wait: jest.fn(() => exited.promise),
    disconnect: jest.fn(),
  };
  const sandbox = {
    commands: {
      run: jest.fn(() => start.promise),
      kill: jest.fn(() => killed.promise),
    },
    kill: jest.fn(),
  };
  const pending = runAttachmentCommand(
    sandbox as any,
    "curl example",
    controller.signal,
  );
  controller.abort();
  start.resolve(handle);
  await Promise.resolve();
  expect(sandbox.commands.kill).toHaveBeenCalledWith(101, {
    requestTimeoutMs: 5000,
  });
  exited.reject(new Error("Process killed"));
  let settled = false;
  void pending.catch(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  killed.resolve(true);
  // The staging layer normalizes a killed process result to signal.reason.
  await expect(pending).rejects.toThrow();
  expect(handle.disconnect).toHaveBeenCalledTimes(1);
  expect(sandbox.kill).not.toHaveBeenCalled();
  expect(sandbox.commands.run.mock.calls[0][1]).not.toHaveProperty("signal");
});

it("disconnects a completed handle and removes its abort listener", async () => {
  const controller = new AbortController();
  const result = { stdout: "ok", stderr: "", exitCode: 0 };
  const handle = {
    pid: 1,
    wait: jest.fn(async () => result),
    disconnect: jest.fn(),
  };
  const sandbox = {
    commands: { run: jest.fn(async () => handle), kill: jest.fn() },
  };
  await expect(
    runAttachmentCommand(sandbox as any, "echo ok", controller.signal),
  ).resolves.toEqual(result);
  controller.abort();
  expect(sandbox.commands.kill).not.toHaveBeenCalled();
  expect(handle.disconnect).toHaveBeenCalledTimes(1);
});
