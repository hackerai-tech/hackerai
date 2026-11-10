import {
  runAttachmentCommand,
  getAttachmentCommandFailureContext,
  AttachmentCommandCleanupError,
} from "../attachment-command";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it.each([true, false])(
  "waits for owned-process cleanup acknowledgement %s after an unfinished wait failure",
  async (receipt) => {
    jest.useFakeTimers();
    const waited = deferred<never>();
    const killed = deferred<boolean>();
    const failure = Object.assign(new Error("SDK wait timed out"), {
      name: "TimeoutError",
    });
    const handle = {
      pid: 701,
      exitCode: undefined,
      wait: jest.fn(() => waited.promise),
      disconnect: jest.fn(),
    };
    const sandbox = {
      commands: {
        run: jest.fn(async () => handle),
        kill: jest.fn(() => killed.promise),
      },
      kill: jest.fn(),
    };
    const controller = new AbortController();
    let settled = false;
    const pending = runAttachmentCommand(
      sandbox as any,
      "private command",
      controller.signal,
    ).catch((error) => {
      settled = true;
      return error;
    });
    try {
      await jest.advanceTimersByTimeAsync(0);
      waited.reject(failure);
      await jest.advanceTimersByTimeAsync(0);
      expect(sandbox.commands.kill).toHaveBeenCalledWith(701, {
        requestTimeoutMs: 5000,
      });
      expect(settled).toBe(false);
      expect(handle.disconnect).not.toHaveBeenCalled();
      // Stop racing the failed-wait cleanup must reuse the same command kill.
      controller.abort();
      killed.resolve(receipt);
      expect(await pending).toBe(failure);
      expect(sandbox.commands.kill).toHaveBeenCalledTimes(1);
      expect(handle.disconnect).toHaveBeenCalledTimes(1);
      expect(sandbox.kill).not.toHaveBeenCalled();
      expect(getAttachmentCommandFailureContext(failure)).toMatchObject({
        attachment_command_stage: "wait",
        attachment_command_handle_acquired: true,
        attachment_command_exit_observed: false,
        attachment_command_cleanup_outcome: receipt ? "killed" : "not_found",
      });
    } finally {
      killed.resolve(receipt);
      await pending;
      jest.useRealTimers();
    }
  },
);

it.each(["rejected", "invalid", "disconnect_failed"] as const)(
  "blocks replay when failed-wait cleanup is %s",
  async (mode) => {
    const failure = new Error("SDK wait failed");
    const killFailure = new Error("SDK kill failed");
    const handle = {
      pid: 702,
      exitCode: undefined,
      wait: jest.fn(async () => {
        throw failure;
      }),
      disconnect: jest.fn(async () => {
        if (mode === "disconnect_failed") {
          throw Object.assign(new Error("disconnect failed"), {
            name: "TimeoutError",
          });
        }
      }),
    };
    const sandbox = {
      commands: {
        run: jest.fn(async () => handle),
        kill: jest.fn(async () => {
          if (mode !== "invalid") throw killFailure;
          return undefined;
        }),
      },
    };
    const error = await runAttachmentCommand(
      sandbox as any,
      "private command",
      new AbortController().signal,
    ).catch((error) => error);
    expect(error).toBeInstanceOf(AttachmentCommandCleanupError);
    if (mode !== "invalid") expect(error.cause).toBe(killFailure);
    expect(sandbox.commands.kill).toHaveBeenCalledWith(702, {
      requestTimeoutMs: 5000,
    });
    expect(getAttachmentCommandFailureContext(error)).toMatchObject({
      attachment_command_cleanup_outcome:
        mode === "invalid" ? "invalid_receipt" : "failed",
    });
    expect(handle.disconnect).toHaveBeenCalledTimes(1);
  },
);

it("does not cancel a command with an observed nonzero exit", async () => {
  const failure = Object.assign(new Error("Command exited"), {
    name: "CommandExitError",
    exitCode: 23,
  });
  const handle = {
    pid: 703,
    exitCode: 23,
    wait: jest.fn(async () => {
      throw failure;
    }),
    disconnect: jest.fn(),
  };
  const sandbox = {
    commands: { run: jest.fn(async () => handle), kill: jest.fn() },
  };
  await expect(
    runAttachmentCommand(
      sandbox as any,
      "private command",
      new AbortController().signal,
    ),
  ).rejects.toBe(failure);
  expect(sandbox.commands.kill).not.toHaveBeenCalled();
  expect(handle.disconnect).toHaveBeenCalledTimes(1);
  expect(getAttachmentCommandFailureContext(failure)).toMatchObject({
    attachment_command_exit_observed: true,
  });
});

it("refuses cleanup with an invalid process identity without sending a kill", async () => {
  const handle = {
    pid: 0,
    exitCode: undefined,
    wait: jest.fn(async () => {
      throw new Error("wait failed");
    }),
    disconnect: jest.fn(),
  };
  const sandbox = {
    commands: { run: jest.fn(async () => handle), kill: jest.fn() },
  };
  await expect(
    runAttachmentCommand(
      sandbox as any,
      "private command",
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(AttachmentCommandCleanupError);
  expect(sandbox.commands.kill).not.toHaveBeenCalled();
  expect(handle.disconnect).toHaveBeenCalledTimes(1);
});

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

it("retains a confirmed successful exit when the SDK stream times out after its end event", async () => {
  const handle = {
    pid: 101,
    exitCode: 0,
    stdout: "complete output",
    stderr: "",
    wait: jest.fn(async () => {
      throw Object.assign(new Error("stream deadline"), {
        name: "TimeoutError",
      });
    }),
    disconnect: jest.fn(),
  };
  const sandbox = {
    commands: { run: jest.fn(async () => handle), kill: jest.fn() },
  };
  await expect(
    runAttachmentCommand(sandbox as any, "true", new AbortController().signal),
  ).resolves.toEqual({ exitCode: 0, stdout: "complete output", stderr: "" });
  expect(sandbox.commands.kill).not.toHaveBeenCalled();
  expect(handle.disconnect).toHaveBeenCalledTimes(1);
});

it("keeps Stop authoritative when an observed successful exit races with a failed wait", async () => {
  const controller = new AbortController();
  const stopReason = new Error("Stop requested");
  const handle = {
    pid: 101,
    exitCode: 0,
    stdout: "complete output",
    stderr: "",
    wait: jest.fn(async () => {
      controller.abort(stopReason);
      throw new Error("stream deadline");
    }),
    disconnect: jest.fn(),
  };
  const sandbox = {
    commands: {
      run: jest.fn(async () => handle),
      kill: jest.fn(async () => false),
    },
  };
  await expect(
    runAttachmentCommand(sandbox as any, "true", controller.signal),
  ).rejects.toBe(stopReason);
  expect(handle.disconnect).toHaveBeenCalledTimes(1);
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

it.each(["foreground", "start", "wait", "disconnect"] as const)(
  "retains the original frozen rejection and finite %s boundary without retrying or logging private data",
  async (stage) => {
    const failure = Object.freeze(
      Object.assign(new Error("private URL, command and /private/path"), {
        name: "TimeoutError",
      }),
    );
    const handle = {
      pid: 987654,
      wait: jest.fn(async () => {
        if (stage === "wait") throw failure;
        return { stdout: "private output", exitCode: 0 };
      }),
      disconnect: jest.fn(async () => {
        if (stage === "disconnect") throw failure;
      }),
    };
    const sandbox = {
      commands: {
        run: jest.fn(async () => {
          if (stage === "start" || stage === "foreground") throw failure;
          return handle;
        }),
        kill: jest.fn(async () => true),
      },
    };
    const controller = new AbortController();
    await expect(
      runAttachmentCommand(
        sandbox as any,
        "private command",
        stage === "foreground" ? undefined : controller.signal,
      ),
    ).rejects.toBe(failure);
    const context = getAttachmentCommandFailureContext(failure);
    expect(context).toEqual({
      attachment_command_diagnostic_version: 1,
      attachment_command_stage: stage,
      attachment_command_handle_acquired:
        stage === "wait" || stage === "disconnect",
      attachment_command_error_kind: "timeout",
      ...(stage === "wait" && {
        attachment_command_exit_observed: false,
        attachment_command_cleanup_outcome: "killed",
      }),
    });
    expect(JSON.stringify(context)).not.toMatch(
      /private|987654|stdout|command:/,
    );
    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(sandbox.commands.kill).toHaveBeenCalledTimes(
      stage === "wait" ? 1 : 0,
    );
    if (stage === "wait" || stage === "disconnect")
      expect(handle.disconnect).toHaveBeenCalledTimes(1);
  },
);

it("awaits a Stop cleanup failure even when wait rejects before its acknowledgement", async () => {
  const waited = deferred<never>();
  const killed = deferred<boolean>();
  const enteredWait = deferred<void>();
  const controller = new AbortController();
  const killFailure = new Error("private kill failure");
  const handle = {
    pid: 43,
    wait: jest.fn(() => {
      enteredWait.resolve();
      return waited.promise;
    }),
    disconnect: jest.fn(),
  };
  const sandbox = {
    commands: {
      run: jest.fn(async () => handle),
      kill: jest.fn(() => killed.promise),
    },
    kill: jest.fn(),
  };
  const pending = runAttachmentCommand(
    sandbox as any,
    "private command",
    controller.signal,
  ).catch((error) => error);
  await enteredWait.promise;
  controller.abort();
  waited.reject(new Error("wait failed before cancellation acknowledgement"));
  await Promise.resolve();
  await Promise.resolve();
  expect(handle.disconnect).not.toHaveBeenCalled();
  killed.reject(killFailure);
  const error = await pending;
  expect(error).toBeInstanceOf(AttachmentCommandCleanupError);
  expect(error.cause).toBe(killFailure);
  expect(getAttachmentCommandFailureContext(error)).toMatchObject({
    attachment_command_stage: "cancel",
    attachment_command_handle_acquired: true,
    attachment_command_error_kind: "other",
  });
  expect(sandbox.commands.kill).toHaveBeenCalledWith(43, {
    requestTimeoutMs: 5000,
  });
  expect(handle.disconnect).toHaveBeenCalledTimes(1);
  expect(sandbox.kill).not.toHaveBeenCalled();
});

it("does not invoke an error name getter or invent context for unrelated rejections", async () => {
  const getter = jest.fn(() => {
    throw new Error("private getter");
  });
  const failure = Object.defineProperty({}, "name", { get: getter });
  const sandbox = {
    commands: {
      run: jest.fn(async () => {
        throw failure;
      }),
    },
  };
  await expect(
    runAttachmentCommand(
      sandbox as any,
      "private command",
      new AbortController().signal,
    ),
  ).rejects.toBe(failure);
  expect(getAttachmentCommandFailureContext(failure)).toMatchObject({
    attachment_command_stage: "start",
    attachment_command_error_kind: "other",
  });
  expect(getter).not.toHaveBeenCalled();
  expect(
    getAttachmentCommandFailureContext(new Error("unrelated")),
  ).toBeUndefined();
  expect(
    getAttachmentCommandFailureContext("private thrown value"),
  ).toBeUndefined();
});

it.each([false, true])(
  "leaves native rejection identity and diagnostics unchanged with signal=%s",
  async (withSignal) => {
    const failure = new Error("native private failure");
    const sandbox = {
      sandboxKind: "centrifugo",
      commands: {
        run: jest.fn(async () => {
          throw failure;
        }),
      },
    };
    await expect(
      runAttachmentCommand(
        sandbox as any,
        "native private command",
        withSignal ? new AbortController().signal : undefined,
      ),
    ).rejects.toBe(failure);
    expect(getAttachmentCommandFailureContext(failure)).toBeUndefined();
  },
);
