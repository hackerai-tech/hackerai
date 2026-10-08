import {
  CloudAcquisitionBudget,
  CLOUD_ACQUISITION_DEADLINE_MS,
  CloudAcquisitionTimeoutError,
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
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
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
});
