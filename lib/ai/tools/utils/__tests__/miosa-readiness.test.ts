import type { Sandbox } from "@miosa/sdk";
import { waitForMiosaReadiness } from "../miosa-readiness";

const createSandbox = () => {
  const sandbox = {
    id: "test-miosa",
    state: "resuming",
    readiness: jest.fn(async () => ({ ready: false, state: "provisioning" })),
    refresh: jest.fn(async () => {
      sandbox.state = "running";
    }),
    waitUntilReady: jest.fn(),
  };
  return sandbox;
};

describe("MIOSA readiness polling", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("waits beyond the 30-second SSE window and refreshes before returning", async () => {
    const s = createSandbox();
    const start = performance.now();
    s.readiness.mockImplementation(async () => ({
      ready: performance.now() - start >= 72_000,
      state: "provisioning",
    }));
    let complete = false;
    const result = waitForMiosaReadiness(s as unknown as Sandbox).then(() => {
      complete = true;
    });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(complete).toBe(false);
    await jest.advanceTimersByTimeAsync(12_000);
    await result;
    expect(s.state).toBe("running");
    expect(s.refresh).toHaveBeenCalledTimes(1);
    expect(s.waitUntilReady).not.toHaveBeenCalled();
    expect(s.readiness).toHaveBeenCalledTimes(25);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(["error", "destroyed", "destroying"])(
    "fails immediately on terminal readiness %s",
    async (state) => {
      const s = createSandbox();
      s.readiness.mockResolvedValue({ ready: false, state });
      await expect(
        waitForMiosaReadiness(s as unknown as Sandbox),
      ).rejects.toMatchObject({ code: "SANDBOX_BOOT_FAILED" });
      expect(s.refresh).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it("does not poll an already terminal sandbox", async () => {
    const s = createSandbox();
    s.state = "destroyed";
    await expect(
      waitForMiosaReadiness(s as unknown as Sandbox),
    ).rejects.toMatchObject({ code: "SANDBOX_BOOT_FAILED" });
    expect(s.readiness).not.toHaveBeenCalled();
  });

  it("does not expose readiness when refresh still reports paused", async () => {
    const s = createSandbox();
    s.readiness.mockResolvedValue({ ready: true, state: "running" });
    s.refresh.mockImplementationOnce(async () => {
      s.state = "paused";
    });
    let complete = false;
    const result = waitForMiosaReadiness(s as unknown as Sandbox).then(() => {
      complete = true;
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(complete).toBe(false);
    await jest.advanceTimersByTimeAsync(3_000);
    await result;
    expect(s.refresh).toHaveBeenCalledTimes(2);
  });

  it("rejects terminal failure discovered during refresh", async () => {
    const s = createSandbox();
    s.readiness.mockResolvedValue({ ready: true, state: "running" });
    s.refresh.mockImplementation(async () => {
      s.state = "error";
    });
    await expect(
      waitForMiosaReadiness(s as unknown as Sandbox),
    ).rejects.toMatchObject({ code: "SANDBOX_BOOT_FAILED" });
  });

  it("propagates API errors without treating them as readiness", async () => {
    const s = createSandbox();
    const error = Object.assign(new Error("unauthorized"), { status: 401 });
    s.readiness.mockRejectedValue(error);
    await expect(waitForMiosaReadiness(s as unknown as Sandbox)).rejects.toBe(
      error,
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it("times out after the full budget and stops polling", async () => {
    const s = createSandbox();
    const result = expect(
      waitForMiosaReadiness(s as unknown as Sandbox),
    ).rejects.toMatchObject({ code: "SANDBOX_READY_TIMEOUT", status: 504 });
    await jest.advanceTimersByTimeAsync(180_000);
    await result;
    const calls = s.readiness.mock.calls.length;
    await jest.advanceTimersByTimeAsync(30_000);
    expect(s.readiness).toHaveBeenCalledTimes(calls);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("bounds a stalled SDK request and ignores its late ready response", async () => {
    const s = createSandbox();
    let resolve!: (value: { ready: boolean; state: string }) => void;
    s.readiness.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const result = expect(
      waitForMiosaReadiness(s as unknown as Sandbox),
    ).rejects.toMatchObject({ code: "SANDBOX_READY_TIMEOUT" });
    await jest.advanceTimersByTimeAsync(180_000);
    await result;
    resolve({ ready: true, state: "running" });
    await jest.advanceTimersByTimeAsync(3_000);
    expect(s.refresh).not.toHaveBeenCalled();
    expect(s.readiness).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
