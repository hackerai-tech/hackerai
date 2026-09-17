import type { Sandbox } from "@miosa/sdk";
import { recoverMiosaAcquisition } from "../miosa-acquisition-recovery";

describe("read-only MIOSA acquisition reconciliation", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const candidate = (state = "running") => ({
    id: "original-id",
    state,
    data: { name: "stable-name", external_user_id: "external-user" },
    pause: jest.fn(),
    resume: jest.fn(),
    destroy: jest.fn(),
  });
  const options = (sandbox = candidate()) => ({
    lookup: jest.fn(async () => sandbox as unknown as Sandbox),
    workspaceName: "stable-name",
    externalUserId: "external-user",
    onObserved: jest.fn(),
  });

  it.each(["running", "resuming", "provisioning"])(
    "returns the original %s VM for separate readiness verification",
    async (state) => {
      const s = candidate(state);
      const result = await recoverMiosaAcquisition({
        ...options(s),
        expectedId: s.id,
      });
      expect(result).toBe(s);
      expect(s.pause).not.toHaveBeenCalled();
      expect(s.resume).not.toHaveBeenCalled();
      expect(s.destroy).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it("finds a late fresh create without creating or replaying a resume", async () => {
    const s = candidate();
    const o = options(s);
    o.lookup.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { name: "NotFoundError" }),
    );
    const pending = recoverMiosaAcquisition(o);
    await jest.advanceTimersByTimeAsync(500);
    expect(await pending).toBe(s);
    expect(o.lookup).toHaveBeenCalledTimes(2);
  });

  it.each(["paused", "pausing", "stopped", "error", "destroyed", "destroying"])(
    "does not mutate a %s VM or claim it executable",
    async (state) => {
      const s = candidate(state);
      await expect(recoverMiosaAcquisition(options(s))).rejects.toMatchObject({
        code: "ACQUISITION_NOT_EXECUTABLE",
      });
      expect(s.pause).not.toHaveBeenCalled();
      expect(s.resume).not.toHaveBeenCalled();
      expect(s.destroy).not.toHaveBeenCalled();
    },
  );

  it("rejects a replacement even if name and external identity match", async () => {
    await expect(
      recoverMiosaAcquisition({ ...options(), expectedId: "different-id" }),
    ).rejects.toMatchObject({ code: "ACQUISITION_IDENTITY_MISMATCH" });
  });

  it.each(["name", "external_user_id"] as const)(
    "requires matching %s when a timed-out create has no known ID",
    async (field) => {
      const s = candidate();
      s.data[field] = "different";
      await expect(recoverMiosaAcquisition(options(s))).rejects.toMatchObject({
        code: "ACQUISITION_IDENTITY_MISMATCH",
      });
    },
  );

  it("does not fall back to name lookup for a missing known VM", async () => {
    const o = options();
    const missing = Object.assign(new Error("not found"), {
      name: "NotFoundError",
    });
    o.lookup.mockRejectedValue(missing);
    await expect(
      recoverMiosaAcquisition({ ...o, expectedId: "original-id" }),
    ).rejects.toBe(missing);
    expect(o.lookup).toHaveBeenCalledTimes(1);
  });

  it("bounds a missing late create and stops polling", async () => {
    const o = options();
    o.lookup.mockRejectedValue(
      Object.assign(new Error("missing"), { name: "NotFoundError" }),
    );
    const result = expect(recoverMiosaAcquisition(o)).rejects.toMatchObject({
      code: "ACQUISITION_RECONCILIATION_TIMEOUT",
    });
    await jest.advanceTimersByTimeAsync(10_000);
    await result;
    const count = o.lookup.mock.calls.length;
    await jest.advanceTimersByTimeAsync(5_000);
    expect(o.lookup).toHaveBeenCalledTimes(count);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("ignores a read that finishes after the deadline", async () => {
    const o = options();
    let resolve!: (s: Sandbox) => void;
    o.lookup.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const result = expect(recoverMiosaAcquisition(o)).rejects.toMatchObject({
      code: "ACQUISITION_RECONCILIATION_TIMEOUT",
    });
    await jest.advanceTimersByTimeAsync(10_000);
    await result;
    resolve(candidate() as unknown as Sandbox);
    await jest.advanceTimersByTimeAsync(0);
    expect(o.onObserved).not.toHaveBeenCalled();
    expect(o.lookup).toHaveBeenCalledTimes(1);
  });
});
