import { EventEmitter } from "events";
import {
  confirmProcessTermination,
  isProcessTreeTerminationConfirmed,
  LOCAL_CANCEL_CONFIRMATION_TIMEOUT_MS,
} from "../command-cancellation";

class FakeProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

describe("confirmProcessTermination", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("does not confirm until the child reaches a terminal state", async () => {
    const proc = new FakeProcess();
    const requestTermination = jest.fn();
    const confirmation = confirmProcessTermination(proc, requestTermination);
    let settled = false;
    void confirmation.then(() => {
      settled = true;
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(requestTermination).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    proc.exitCode = 0;
    proc.emit("close", 0, null);
    await expect(confirmation).resolves.toBe(true);
  });

  it("waits for the process tree after the root process exits", async () => {
    const proc = new FakeProcess();
    let processTreeAlive = true;
    const confirmation = confirmProcessTermination(
      proc,
      jest.fn(),
      LOCAL_CANCEL_CONFIRMATION_TIMEOUT_MS,
      () => !processTreeAlive,
    );
    let settled = false;
    void confirmation.then(() => {
      settled = true;
    });

    proc.exitCode = 0;
    proc.emit("close", 0, null);
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    processTreeAlive = false;
    await jest.advanceTimersByTimeAsync(50);
    await expect(confirmation).resolves.toBe(true);
  });

  it("reports false when no terminal acknowledgement arrives", async () => {
    const proc = new FakeProcess();
    const confirmation = confirmProcessTermination(proc, jest.fn());

    jest.advanceTimersByTime(LOCAL_CANCEL_CONFIRMATION_TIMEOUT_MS + 1);

    await expect(confirmation).resolves.toBe(false);
  });

  it("reports false when requesting termination throws", async () => {
    const proc = new FakeProcess();

    await expect(
      confirmProcessTermination(proc, () => {
        throw new Error("signal failed");
      }),
    ).resolves.toBe(false);
  });

  it("reports false when the child emits an error", async () => {
    const proc = new FakeProcess();
    const confirmation = confirmProcessTermination(proc, jest.fn());

    proc.emit("error", new Error("signal delivery failed"));

    await expect(confirmation).resolves.toBe(false);
  });

  it("preserves already-confirmed terminal state", async () => {
    const proc = new FakeProcess();
    proc.exitCode = 0;
    const requestTermination = jest.fn();

    await expect(
      confirmProcessTermination(proc, requestTermination),
    ).resolves.toBe(true);
    expect(requestTermination).not.toHaveBeenCalled();
  });
});

describe("isProcessTreeTerminationConfirmed", () => {
  it("does not treat a terminated Unix root as a terminated process group", () => {
    const proc = new FakeProcess();
    proc.exitCode = 0;
    Object.assign(proc, { pid: 123 });
    const signalProcessGroup = jest.fn();

    expect(
      isProcessTreeTerminationConfirmed(
        proc as FakeProcess & { pid: number },
        "darwin",
        signalProcessGroup,
      ),
    ).toBe(false);
    expect(signalProcessGroup).toHaveBeenCalledWith(-123, 0);
  });

  it("confirms Unix process-group termination only after ESRCH", () => {
    const proc = Object.assign(new FakeProcess(), { pid: 123 });
    const missingProcessGroup = jest.fn(() => {
      const error = new Error("No such process") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });

    expect(
      isProcessTreeTerminationConfirmed(proc, "linux", missingProcessGroup),
    ).toBe(true);
  });

  it("does not confirm Unix process-group termination on probe errors", () => {
    const proc = Object.assign(new FakeProcess(), { pid: 123 });
    const deniedProbe = jest.fn(() => {
      const error = new Error("Not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    expect(isProcessTreeTerminationConfirmed(proc, "linux", deniedProbe)).toBe(
      false,
    );
  });
});
