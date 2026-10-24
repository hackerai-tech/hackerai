jest.mock("@/lib/cloud-recovery/store", () => ({
  readFailures: jest.fn(async () => null),
  recordResumeFailure: jest.fn(async () => {}),
  clearResumeFailures: jest.fn(async () => {}),
}));
jest.mock("@/lib/cloud-network/service", () => ({
  readNetworkSettings: jest.fn(async () => null),
  ensureCloudNetwork: jest.fn(async () => {}),
}));
jest.mock("../cloud-workspace-guard", () => ({
  ...jest.requireActual("../cloud-workspace-guard"),
  readCloudWorkspaceState: jest.fn(async () => null),
  assertCloudWorkspaceAvailable: jest.fn(async () => {}),
  registerE2BWorkspaceLease: jest.fn(),
  refreshE2BWorkspaceLease: jest.fn(async () => {}),
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));
jest.mock("@e2b/code-interpreter", () => {
  class E2BError extends Error {}
  return {
    Sandbox: class {
      static list = jest.fn();
      static getInfo = jest.fn();
      static connect = jest.fn();
      static create = jest.fn();
      static kill = jest.fn();
    },
    SandboxError: E2BError,
    TimeoutError: class extends E2BError {},
    NotFoundError: class extends E2BError {},
    AuthenticationError: class extends E2BError {},
    NotEnoughSpaceError: class extends E2BError {},
    RateLimitError: class extends E2BError {},
    TemplateError: class extends E2BError {},
    InvalidArgumentError: class extends E2BError {},
    CommandExitError: class extends E2BError {},
  };
});

import { Sandbox, TimeoutError } from "@e2b/code-interpreter";
import { clearResumeFailures } from "@/lib/cloud-recovery/store";
import { readCloudWorkspaceState } from "../cloud-workspace-guard";
import { DefaultSandboxManager } from "../sandbox-manager";
import { HybridSandboxManager } from "../hybrid-sandbox-manager";
import { CloudAcquisitionTimeoutError } from "../cloud-acquisition-budget";
import type { CloudSandboxAcquisitionContext } from "../cloud-sandbox";

const api = jest.mocked(Sandbox);
const info = {
  sandboxId: "fixture-workspace",
  state: "paused",
  metadata: {
    userID: "fixture-user",
    template: "terminal-agent-sandbox",
    sandboxVersion: "v12",
    e2bCluster: "us",
  },
};

// Exercise both real managers through routing, identity, provider and publication.
// Only external services are mocked; fake time makes the long wait deterministic.
describe.each(["default", "hybrid"] as const)(
  "%s slow normal resume",
  (kind) => {
    const originalEnv = process.env;
    let publish: jest.Mock;
    let onBoot: jest.Mock;
    let onTimeout: jest.Mock;
    let controller: AbortController;
    let sandbox: Sandbox;
    const manager = () => {
      const context: CloudSandboxAcquisitionContext = {
        signal: controller.signal,
        onTimeout,
        triggerRegion: "us-east-1",
      };
      return kind === "default"
        ? new DefaultSandboxManager(
            "fixture-user",
            publish,
            null,
            onBoot,
            context,
          )
        : new HybridSandboxManager(
            "fixture-user",
            publish,
            "e2b",
            "fixture-key",
            null,
            undefined,
            onBoot,
            undefined,
            undefined,
            undefined,
            context,
          );
    };

    beforeEach(() => {
      jest.clearAllMocks();
      jest.useFakeTimers();
      process.env = { ...originalEnv, E2B_TEMPLATE: "terminal-agent-sandbox" };
      delete process.env.CLOUD_DISK_RECOVERY_TARGETS;
      jest.spyOn(console, "warn").mockImplementation(() => {});
      jest.spyOn(console, "info").mockImplementation(() => {});
      publish = jest.fn();
      onBoot = jest.fn();
      onTimeout = jest.fn();
      controller = new AbortController();
      sandbox = Object.assign(new Sandbox({} as never), {
        sandboxId: info.sandboxId,
        setTimeout: jest.fn(async () => {}),
        commands: {
          run: jest.fn(async () => ({ exitCode: 0, stdout: "done" })),
        },
      });
      api.list.mockReturnValue({
        nextItems: jest.fn(async () => [info]),
        hasNext: false,
      } as never);
      api.getInfo.mockResolvedValue(info as never);
      jest.mocked(readCloudWorkspaceState).mockResolvedValue(null);
    });
    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
      process.env = originalEnv;
    });

    it.each([false, true])(
      "shares one slow resume and publishes only after readiness (pinned=%s)",
      async (pinned) => {
        if (pinned)
          jest.mocked(readCloudWorkspaceState).mockResolvedValue({
            version: 1,
            phase: "e2b",
            token: "fixture",
            sourceId: "old-fixture",
            destinationId: info.sandboxId,
            region: "us-east-1",
          });
        api.connect.mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve(sandbox), 70_000),
            ),
        );
        const current = manager();
        const first = current.getSandbox();
        const joined = current.getSandbox();
        await jest.advanceTimersByTimeAsync(45_000);
        expect(publish).not.toHaveBeenCalled();
        expect(onBoot).not.toHaveBeenCalled();
        expect(onTimeout).not.toHaveBeenCalled();
        expect(api.connect).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(25_000);
        expect((await first).sandbox).toBe(sandbox);
        expect((await joined).sandbox).toBe(sandbox);
        expect(publish).toHaveBeenCalledTimes(1);
        expect(api.connect).toHaveBeenCalledWith(
          info.sandboxId,
          expect.objectContaining({ requestTimeoutMs: 90_000, retries: 0 }),
        );
        expect(api.connect.mock.calls[0][1]).not.toHaveProperty(
          "onResume",
          "reboot",
        );
        expect(api.create).not.toHaveBeenCalled();
        expect(api.kill).not.toHaveBeenCalled();
        await expect(current.getSandbox()).resolves.toEqual({ sandbox });
        expect(api.connect).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["deadline", "cancel"] as const)(
      "rejects a late provider success after %s without dispatching a command",
      async (outcome) => {
        let finish!: (value: Sandbox) => void;
        api.connect.mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
        const current = manager();
        const command = current
          .getSandbox()
          .then(({ sandbox: ready }) => ready.commands.run("fixture-command"))
          .catch((error) => error);
        const joined = current.getSandbox().catch((error) => error);
        await jest.advanceTimersByTimeAsync(
          outcome === "deadline" ? 90_000 : 45_000,
        );
        if (outcome === "cancel")
          controller.abort(new DOMException("Stopped", "AbortError"));
        const failure = await command;
        expect(await joined).toBe(failure);
        if (outcome === "deadline")
          expect(failure).toBeInstanceOf(CloudAcquisitionTimeoutError);
        else expect(failure).toBe(controller.signal.reason);
        expect(onTimeout).toHaveBeenCalledTimes(outcome === "deadline" ? 1 : 0);
        finish(sandbox);
        await jest.advanceTimersByTimeAsync(1);
        expect(sandbox.commands.run).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        expect(onBoot).not.toHaveBeenCalled();
        await expect(current.getSandbox()).rejects.toThrow();
        expect(api.connect).toHaveBeenCalledTimes(1);
        expect(api.create).not.toHaveBeenCalled();
        expect(api.kill).not.toHaveBeenCalled();
      },
    );

    it("does not automatically repeat an uncertain provider resume failure", async () => {
      api.connect.mockRejectedValue(
        new TimeoutError("requestTimeoutMs exceeded"),
      );
      const result = manager()
        .getSandbox()
        .catch((error) => error);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await result).toBeInstanceOf(Error);
      expect(api.connect).toHaveBeenCalledTimes(1);
      expect(api.create).not.toHaveBeenCalled();
      expect(api.kill).not.toHaveBeenCalled();
    });

    it("does not publish if failure-record cleanup finishes after the deadline", async () => {
      api.connect.mockResolvedValue(sandbox);
      let finish!: () => void;
      jest.mocked(clearResumeFailures).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const result = manager()
        .getSandbox()
        .catch((error) => error);
      await jest.advanceTimersByTimeAsync(90_000);
      expect(await result).toBeInstanceOf(CloudAcquisitionTimeoutError);
      finish();
      await jest.advanceTimersByTimeAsync(1);
      expect(publish).not.toHaveBeenCalled();
      expect(onBoot).not.toHaveBeenCalled();
    });
  },
);
