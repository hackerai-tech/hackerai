import { classifySandboxReadinessFailureSignal } from "../sandbox-readiness-failure";
import {
  CloudAcquisitionBudget,
  CLOUD_ACQUISITION_DEADLINE_MS,
  CloudAcquisitionTimeoutError,
  CloudAcquisitionBudgetExhaustedError,
  isCloudAcquisitionBudgetSpent,
} from "../cloud-acquisition-budget";

describe("cloud acquisition deadline", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("retains the last bounded stage when the provider ignores cancellation", async () => {
    let reportStage!: (stage: "connect" | "create") => void;
    const result = new CloudAcquisitionBudget()
      .run(
        async (_, report) => {
          reportStage = report;
          report("discovery");
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          report("connect");
          return new Promise(() => {});
        },
        { userId: "test" },
      )
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(30_000);
    reportStage("create");
    expect(await result).toMatchObject({ acquisitionStage: "connect" });
    expect(
      JSON.parse(String(jest.mocked(console.warn).mock.calls[0][0])),
    ).toMatchObject({
      acquisition_stage: "connect",
      stage_elapsed_ms: 25_000,
      failed_acquisition_wait_ms: 30_000,
    });
  });

  it("bounds a never-settling call, aborts its signal, and refuses another attempt", async () => {
    const budget = new CloudAcquisitionBudget();
    let signal!: AbortSignal;
    const acquire = jest.fn((value: AbortSignal) => {
      signal = value;
      return new Promise(() => {});
    });
    const onTimeout = jest.fn();
    const result = budget
      .run(acquire, { userId: "test", onTimeout })
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(CLOUD_ACQUISITION_DEADLINE_MS);
    expect(await result).toBeInstanceOf(CloudAcquisitionTimeoutError);
    expect(signal.aborted).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    await expect(budget.run(acquire, { userId: "test" })).rejects.toThrow(
      "workspace is preserved",
    );
    const exhausted = await budget
      .run(acquire, { userId: "test" })
      .catch((error) => error);
    expect(classifySandboxReadinessFailureSignal(exhausted)).toBe(
      "operation_timeout",
    );
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("marks the final fast failure as exhausted while preserving its provider cause", async () => {
    const budget = new CloudAcquisitionBudget();
    const cause = new Error("connection timed out");
    const acquire = jest.fn(async () => {
      throw cause;
    });
    const first = await budget
      .run(acquire, { userId: "test" })
      .catch((error) => error);
    expect(first).toBe(cause);
    expect(isCloudAcquisitionBudgetSpent(first)).toBe(false);
    const final = await budget
      .run(acquire, { userId: "test" })
      .catch((error) => error);
    expect(final).toBeInstanceOf(CloudAcquisitionBudgetExhaustedError);
    expect(final.cause).toBe(cause);
    expect(isCloudAcquisitionBudgetSpent(final)).toBe(true);
    expect(classifySandboxReadinessFailureSignal(final)).toBe(
      "operation_timeout",
    );
    await expect(budget.run(acquire, { userId: "test" })).rejects.toMatchObject(
      { cause },
    );
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("shares remaining time across failed acquisition attempts", async () => {
    const budget = new CloudAcquisitionBudget();
    const first = budget
      .run(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("504")), 20_000),
          ),
        { userId: "test" },
      )
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(20_000);
    expect((await first).message).toBe("504");
    const second = budget
      .run(() => new Promise(() => {}), { userId: "test" })
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await second).toBeInstanceOf(CloudAcquisitionTimeoutError);
  });

  it("propagates user cancellation promptly without a timeout notice", async () => {
    const controller = new AbortController();
    const onTimeout = jest.fn();
    let requestSignal!: AbortSignal;
    const result = new CloudAcquisitionBudget()
      .run(
        (signal) => {
          requestSignal = signal;
          return new Promise(() => {});
        },
        { userId: "test", signal: controller.signal, onTimeout },
      )
      .catch((error) => error);
    const reason = new DOMException("Stopped", "AbortError");
    controller.abort(reason);
    expect(await result).toBe(reason);
    expect(requestSignal.aborted).toBe(true);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("never starts acquisition when its caller is already canceled", async () => {
    const controller = new AbortController();
    controller.abort();
    const acquire = jest.fn();
    const onTimeout = jest.fn();
    await expect(
      new CloudAcquisitionBudget().run(acquire, {
        userId: "test",
        signal: controller.signal,
        onTimeout,
      }),
    ).rejects.toBe(controller.signal.reason);
    expect(acquire).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("does not abort a successfully returned client later", async () => {
    let signal!: AbortSignal;
    await new CloudAcquisitionBudget().run(
      async (value) => {
        signal = value;
        return "connected";
      },
      { userId: "test" },
    );
    await jest.advanceTimersByTimeAsync(60_000);
    expect(signal.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("does not count caller cancellation as a provider failure", async () => {
    const budget = new CloudAcquisitionBudget();
    const controller = new AbortController();
    const cancelled = budget
      .run(() => new Promise(() => {}), {
        userId: "test",
        signal: controller.signal,
      })
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(20_000);
    controller.abort();
    await cancelled;
    await expect(
      budget.run(
        async () => {
          throw new Error("504");
        },
        {
          userId: "test",
        },
      ),
    ).rejects.toThrow("504");
    expect(console.warn).not.toHaveBeenCalled();
    const result = budget
      .run(() => new Promise(() => {}), { userId: "test" })
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(await result).toBeInstanceOf(CloudAcquisitionTimeoutError);
  });
});
