import type { AnySandbox } from "@/types";
import { createRedisClient } from "@/lib/rate-limit/redis";
import { CloudMigrationUnavailableError } from "../cloud-migration-state";
import { refreshE2BSandboxLeaseBestEffort } from "../sandbox";
import { DefaultSandboxManager } from "../sandbox-manager";
import { HybridSandboxManager } from "../hybrid-sandbox-manager";
import { ensureCloudSandboxConnection } from "../cloud-sandbox";
import { isMiosaCloudSandboxPaused } from "../miosa-rollout";
jest.mock("../miosa-rollout", () => ({
  isMiosaCloudSandboxPaused: jest.fn(() => false),
}));

jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));

jest.mock("../cloud-sandbox", () => ({
  ensureCloudSandboxConnection: jest.fn(),
}));
jest.mock("../sandbox", () => ({
  refreshE2BSandboxLeaseBestEffort: jest.fn(),
}));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));

const acquire = jest.mocked(ensureCloudSandboxConnection);
const e2b = { sandboxId: "e2b-existing" } as AnySandbox;
const miosa = {
  sandboxKind: "miosa",
  sandboxId: "miosa-existing",
} as AnySandbox;
const context = { provider: "miosa" as const, chatId: "test-chat" };

describe.each(["default", "hybrid"] as const)(
  "%s cloud acquisition recovery",
  (kind) => {
    const createManager = (initial?: AnySandbox) =>
      kind === "default"
        ? new DefaultSandboxManager(
            "user",
            jest.fn(),
            initial,
            undefined,
            context,
          )
        : new HybridSandboxManager(
            "user",
            jest.fn(),
            "e2b",
            "test-service",
            initial,
            "pro",
            undefined,
            undefined,
            undefined,
            undefined,
            context,
          );

    const redis = {
      get: jest.fn(async () => null),
      eval: jest.fn(async () => 1),
    };

    beforeEach(() => {
      jest.resetAllMocks();
      jest.mocked(isMiosaCloudSandboxPaused).mockReturnValue(false);
      redis.get.mockResolvedValue(null);
      redis.eval.mockResolvedValue(1);
      jest.mocked(createRedisClient).mockReturnValue(redis as never);
    });

    it.each([false, true])(
      "reuses the verified recovered destination on repeated tools (initial: %s)",
      async (initial) => {
        redis.eval.mockImplementation(async (...args: unknown[]) => {
          const values = args[2] as string[];
          return values[1] === e2b.sandboxId ? 1 : 0;
        });
        acquire.mockResolvedValue({ sandbox: e2b, provider: "e2b" });
        const manager = createManager(initial ? e2b : undefined);

        for (let request = 0; request < 3; request++) {
          await expect(manager.getSandbox()).resolves.toEqual({ sandbox: e2b });
        }
        expect(acquire).toHaveBeenCalledTimes(initial ? 0 : 1);
        expect(refreshE2BSandboxLeaseBestEffort).toHaveBeenCalledTimes(
          initial ? 3 : 2,
        );
      },
    );

    it("reacquires the current E2B pin after the cached destination changes", async () => {
      redis.eval.mockImplementation(async (...args: unknown[]) => {
        const values = args[2] as string[];
        return values[1] === "another-destination" ? 1 : 0;
      });
      const manager = createManager(e2b);
      const current = { sandboxId: "another-destination" } as AnySandbox;
      acquire.mockResolvedValue({ sandbox: current, provider: "e2b" });
      await expect(manager.getSandbox()).resolves.toEqual({ sandbox: current });
      expect(refreshE2BSandboxLeaseBestEffort).not.toHaveBeenCalled();
      expect(acquire).toHaveBeenCalledTimes(1);
    });

    it("keeps cached tools blocked while workspace recovery is fenced", async () => {
      redis.eval.mockResolvedValue(0);
      acquire.mockRejectedValue(new CloudMigrationUnavailableError());
      const manager = createManager(e2b);

      await expect(manager.getSandbox()).rejects.toBeInstanceOf(
        CloudMigrationUnavailableError,
      );
      expect(refreshE2BSandboxLeaseBestEffort).not.toHaveBeenCalled();
      expect(acquire).toHaveBeenCalledTimes(1);
    });

    it("reacquires E2B instead of reusing a cached MIOSA client while paused", async () => {
      jest.mocked(isMiosaCloudSandboxPaused).mockReturnValue(true);
      acquire.mockResolvedValue({ sandbox: e2b, provider: "e2b" });
      const manager = createManager(miosa);
      await expect(manager.getSandbox()).resolves.toEqual({ sandbox: e2b });
      expect(acquire).toHaveBeenCalledTimes(1);
    });

    it("shares reacquisition after concurrent cached tools hit a migration fence", async () => {
      redis.eval.mockResolvedValue(0);
      acquire.mockResolvedValue({ sandbox: e2b, provider: "e2b" });
      const manager = createManager(e2b);
      await expect(
        Promise.all(Array.from({ length: 10 }, () => manager.getSandbox())),
      ).resolves.toEqual(Array(10).fill({ sandbox: e2b }));
      expect(acquire).toHaveBeenCalledTimes(1);
    });

    it("shares one acquisition across concurrent tool requests", async () => {
      let complete!: (result: {
        sandbox: AnySandbox;
        provider: "miosa";
      }) => void;
      acquire.mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const manager = createManager();
      const requests = Array.from({ length: 10 }, () => manager.getSandbox());
      await Promise.resolve();
      expect(acquire).toHaveBeenCalledTimes(1);
      complete({ sandbox: miosa, provider: "miosa" });
      expect(await Promise.all(requests)).toEqual(
        Array(10).fill({ sandbox: miosa }),
      );
    });

    it("reconnects to E2B after fallback without trying Miosa again", async () => {
      acquire.mockResolvedValue({ sandbox: e2b, provider: "e2b" });
      const manager = createManager();
      await manager.getSandbox();
      await manager.resetSandbox();
      await manager.getSandbox();
      expect(
        acquire.mock.calls.map(([options]) => options.context?.provider),
      ).toEqual(["miosa", "e2b"]);
      expect(acquire.mock.calls[1][0].context?.chatId).toBe("test-chat");
      expect(manager.getSandboxInfo()).toEqual({
        type: "cloud",
        provider: "e2b",
      });
    });

    it("retains an initial E2B workspace despite a Miosa assignment", async () => {
      acquire.mockResolvedValue({ sandbox: e2b, provider: "e2b" });
      const manager = createManager(e2b);
      expect(await manager.getSandbox()).toEqual({ sandbox: e2b });
      expect(acquire).not.toHaveBeenCalled();
      await manager.resetSandbox();
      await manager.getSandbox();
      expect(acquire.mock.calls[0][0].context?.provider).toBe("e2b");
    });

    it("clears a rejected acquisition so a later request can retry", async () => {
      const error = new Error("both providers unavailable");
      acquire
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ sandbox: miosa, provider: "miosa" });
      const manager = createManager();
      const results = await Promise.allSettled([
        manager.getSandbox(),
        manager.getSandbox(),
      ]);
      expect(results).toEqual([
        { status: "rejected", reason: error },
        { status: "rejected", reason: error },
      ]);
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(await manager.getSandbox()).toEqual({ sandbox: miosa });
      expect(acquire).toHaveBeenCalledTimes(2);
    });

    it("does not repopulate the cache after reset during acquisition", async () => {
      let complete!: (result: { sandbox: AnySandbox; provider: "e2b" }) => void;
      acquire.mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      acquire.mockResolvedValueOnce({ sandbox: e2b, provider: "e2b" });
      const manager = createManager();
      const first = manager.getSandbox();
      const reset = manager.resetSandbox();
      await Promise.resolve();
      complete({ sandbox: e2b, provider: "e2b" });
      await Promise.all([first, reset]);
      await manager.getSandbox();
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(acquire.mock.calls[1][0].context?.provider).toBe("e2b");
    });
  },
);
