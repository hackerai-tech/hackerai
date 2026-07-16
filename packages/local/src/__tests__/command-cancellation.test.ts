import { EventEmitter } from "events";
import {
  confirmProcessTermination,
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

    proc.emit("close", null, "SIGTERM");
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
