const get = jest.fn();
const set = jest.fn();
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => ({ get, set }),
}));

import {
  assertMiosaAcquisitionNotCoolingDown,
  rememberTerminalMiosaFailure,
} from "../miosa-acquisition-cooldown";

describe("Miosa acquisition cooldown", () => {
  beforeEach(() => {
    get.mockReset();
    set.mockReset();
  });

  it("skips a known missing snapshot for two minutes, then permits retry", async () => {
    const error = Object.assign(new Error("private response"), {
      code: "SNAPSHOT_MISSING",
    });
    await rememberTerminalMiosaFailure("user-1", error);
    expect(set).toHaveBeenCalledWith(
      "miosa_acquisition_cooldown:v1:user-1",
      "1",
      { ex: 120 },
    );
    get.mockResolvedValueOnce("1").mockResolvedValueOnce(null);
    await expect(
      assertMiosaAcquisitionNotCoolingDown("user-1"),
    ).rejects.toMatchObject({ code: "ACQUISITION_COOLDOWN" });
    await expect(
      assertMiosaAcquisitionNotCoolingDown("user-1"),
    ).resolves.toBeUndefined();
  });

  it("does not cool down ordinary transient errors", async () => {
    await rememberTerminalMiosaFailure("user-1", new Error("private response"));
    expect(set).not.toHaveBeenCalled();
  });

  it("cools down a sandbox observed in terminal error", async () => {
    const error = Object.assign(new Error("private response"), {
      sandboxState: "error",
    });
    await rememberTerminalMiosaFailure("user-2", error);
    expect(set).toHaveBeenCalledWith(
      "miosa_acquisition_cooldown:v1:user-2",
      "1",
      { ex: 120 },
    );
  });

  it("does not strand acquisition when the cooldown store fails", async () => {
    get.mockRejectedValueOnce(new Error("redis down"));
    await expect(
      assertMiosaAcquisitionNotCoolingDown("user-1"),
    ).resolves.toBeUndefined();
  });
});
