const action = jest.fn();

jest.mock("@/convex/_generated/api", () => ({
  api: {
    e2bNetworkConfigActions: {
      acquireE2BNetworkMigrationLease: "acquireMigrationLease",
      releaseE2BNetworkMigrationLease: "releaseMigrationLease",
    },
  },
}));

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ action }),
}));

import { acquireE2BNetworkMigrationLease } from "../e2b-network-config";

describe("E2B network migration lease client", () => {
  beforeEach(() => {
    action.mockReset();
  });

  it("retries release after a transient failure", async () => {
    action
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("temporary Convex failure"))
      .mockResolvedValueOnce(null);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const release = await acquireE2BNetworkMigrationLease({
        userId: "user-1",
        serviceKey: "service-key",
      });

      expect(release).not.toBeNull();
      await release!();
      await release!();
      await release!();

      expect(action).toHaveBeenCalledTimes(3);
      expect(action.mock.calls[1][0]).toBe("releaseMigrationLease");
      expect(action.mock.calls[2][0]).toBe("releaseMigrationLease");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
