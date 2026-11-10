import type { AnySandbox } from "@/types";
import { BrowserSessions } from "../browser-sessions";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: jest.fn(),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { info: jest.fn() },
}));

function sandbox() {
  return {
    sandboxId: "test-sandbox",
    commands: { run: jest.fn(async () => ({ exitCode: 0 })) },
  };
}

describe("browser preparation attribution", () => {
  const scope = {
    userId: "opaque-user",
    chatId: "opaque-chat",
    runId: "run_opaque",
    agentId: "agent_opaque",
    serviceKey: "PRIVATE_SERVICE_KEY",
  };
  let mutation: jest.Mock;
  beforeEach(() => {
    jest.clearAllMocks();
    mutation = jest.fn(async () => true);
    jest.mocked(getConvexClient).mockReturnValue({ mutation } as never);
  });

  it.each([
    "gate_only",
    "recognized_browser_command",
    "interactive_shell",
    "internal",
  ] as const)(
    "retains the first %s reason across concurrent reuse",
    async (reason) => {
      const target = sandbox();
      target.commands.run.mockImplementation(async () => ({
        exitCode: 0,
        stdout: "/usr/bin",
      }));
      const owner = new BrowserSessions(scope);
      const [first, reused] = await Promise.all([
        owner.prepare(target as unknown as AnySandbox, reason),
        owner.prepare(
          target as unknown as AnySandbox,
          "recognized_browser_command",
        ),
      ]);
      expect(first).toEqual(reused);
      expect(phLogger.info).toHaveBeenCalledTimes(1);
      expect(phLogger.info).toHaveBeenCalledWith(
        "browser_session_preparation_diagnostics",
        {
          diagnostic_version: 1,
          observation_scope: "initial_registered_root",
          preparation_reason: reason,
          browser_session_id: expect.stringMatching(/^[a-f0-9]{32}$/),
          trigger_run_id: "run_opaque",
          agent_id: "agent_opaque",
        },
      );
      expect(target.commands.run).toHaveBeenCalledTimes(1);
      await owner.cleanup();
    },
  );

  it("reports only after successful registration without replacing the creation reason", async () => {
    const target = sandbox();
    target.commands.run.mockImplementation(async () => ({
      exitCode: 0,
      stdout: "/usr/bin",
    }));
    mutation.mockResolvedValueOnce(false);
    const owner = new BrowserSessions(scope);
    await owner.prepare(target as unknown as AnySandbox, "gate_only");
    expect(phLogger.info).not.toHaveBeenCalled();
    await owner.prepare(
      target as unknown as AnySandbox,
      "recognized_browser_command",
    );
    expect(phLogger.info).toHaveBeenCalledWith(
      "browser_session_preparation_diagnostics",
      expect.objectContaining({ preparation_reason: "gate_only" }),
    );
    expect(target.commands.run).toHaveBeenCalledTimes(1);
    await owner.cleanup();
  });

  it("cannot leak arbitrary reasons or scope contents, and delivery failure leaves setup usable", async () => {
    const target = sandbox();
    target.commands.run.mockImplementation(async () => ({
      exitCode: 0,
      stdout: "/usr/bin",
    }));
    const owner = new BrowserSessions({
      ...scope,
      runId: "PRIVATE_SERVICE_KEY",
      agentId: "https://private.example",
    });
    jest.mocked(phLogger.info).mockImplementationOnce(() => {
      throw new Error("sink unavailable");
    });
    const env = await owner.prepare(
      target as unknown as AnySandbox,
      "https://private.example" as never,
    );
    expect(env.AGENT_BROWSER_SOCKET_DIR).toMatch(
      /^\/dev\/shm\/hackerai-browser-/,
    );
    expect(phLogger.info).toHaveBeenCalledWith(
      "browser_session_preparation_diagnostics",
      expect.objectContaining({
        preparation_reason: "internal",
        trigger_run_id: "unknown",
        agent_id: "unknown",
      }),
    );
    await owner.prepare(target as unknown as AnySandbox);
    expect(phLogger.info).toHaveBeenCalledTimes(1);
    await owner.cleanup();
  });
});

describe("managed browser ownership", () => {
  it.each([true, false])(
    "checks the managed rollout once while sharing concurrent preparation: %s",
    async (enabled) => {
      const target = sandbox();
      const decide = jest.fn(async () => enabled);
      const owner = new BrowserSessions(undefined, undefined, undefined, {
        enabled: decide,
      });
      const [a, b] = await Promise.all([
        owner.prepare(target as unknown as AnySandbox),
        owner.prepare(target as unknown as AnySandbox),
      ]);
      expect(a).toEqual(b);
      expect(target.commands.run).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenCalledTimes(1);
      const command = (
        target.commands.run.mock.calls[0] as unknown as [string]
      )[0];
      if (enabled) expect(command).toContain("hackerai.cloudflareChallenge");
      else expect(command).not.toContain("hackerai.cloudflareChallenge");
      await owner.cleanup();
    },
  );
  it("isolates parent, sibling, and later-run sockets and encryption keys", async () => {
    const target = sandbox();
    const owners = [
      new BrowserSessions(),
      new BrowserSessions(),
      new BrowserSessions(),
    ];
    const envs = await Promise.all(
      owners.map((owner) => owner.prepare(target as unknown as AnySandbox)),
    );
    expect(new Set(envs.map((env) => env.AGENT_BROWSER_SOCKET_DIR)).size).toBe(
      3,
    );
    expect(
      new Set(envs.map((env) => env.AGENT_BROWSER_ENCRYPTION_KEY)).size,
    ).toBe(3);
    for (const env of envs) {
      expect(env.AGENT_BROWSER_SOCKET_DIR.length).toBeLessThan(85);
      expect(env.AGENT_BROWSER_ENCRYPTION_KEY).toMatch(/^[a-f0-9]{64}$/);
      expect(env.AGENT_BROWSER_SESSION_NAME).toBeUndefined();
      expect(env.HOME).toBeUndefined();
      expect(target.commands.run.mock.calls.flat().join(" ")).not.toContain(
        env.AGENT_BROWSER_ENCRYPTION_KEY,
      );
    }
    await Promise.all(owners.map((owner) => owner.cleanup()));
  });

  it("shares preparation across simultaneous calls but rejects commands after cleanup", async () => {
    const target = sandbox();
    const owner = new BrowserSessions();
    const [a, b] = await Promise.all([
      owner.prepare(target as unknown as AnySandbox),
      owner.prepare(target as unknown as AnySandbox),
    ]);
    expect(a).toEqual(b);
    expect(target.commands.run).toHaveBeenCalledTimes(1);
    await Promise.all([owner.cleanup(), owner.cleanup()]);
    expect(target.commands.run).toHaveBeenCalledTimes(2);
    await expect(
      owner.prepare(target as unknown as AnySandbox),
    ).rejects.toThrow("ownership has ended");
  });

  it("keeps the same browser namespace when the sandbox transport reconnects", async () => {
    const owner = new BrowserSessions();
    const first = sandbox();
    const reconnect = sandbox();
    const initial = await owner.prepare(first as unknown as AnySandbox);
    expect(await owner.prepare(reconnect as unknown as AnySandbox)).toEqual(
      initial,
    );
    expect(reconnect.commands.run).not.toHaveBeenCalled();
    await owner.cleanup();
    expect(reconnect.commands.run).toHaveBeenCalledTimes(1);
  });

  it("waits for in-flight setup when cancellation wins", async () => {
    let finish!: () => void;
    const target = sandbox();
    target.commands.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ exitCode: 0 });
        }),
    );
    const owner = new BrowserSessions();
    const preparation = owner.prepare(target as unknown as AnySandbox);
    const rejected = expect(preparation).rejects.toThrow("ownership has ended");
    const cleanup = owner.cleanup();
    finish();
    await rejected;
    await cleanup;
    expect(target.commands.run).toHaveBeenCalledTimes(2);
  });

  it("fails closed if setup fails, still attempting cleanup", async () => {
    const target = sandbox();
    target.commands.run.mockRejectedValueOnce(new Error("unavailable"));
    const owner = new BrowserSessions();
    await expect(
      owner.prepare(target as unknown as AnySandbox),
    ).rejects.toThrow("unavailable");
    await owner.cleanup();
    expect(target.commands.run).toHaveBeenCalledTimes(2);
  });

  it("does not create directories or authentication files on connected hosts", async () => {
    const target = { ...sandbox(), sandboxKind: "centrifugo" };
    const owner = new BrowserSessions();
    expect(await owner.prepare(target as unknown as AnySandbox)).toEqual({});
    await owner.cleanup();
    expect(target.commands.run).not.toHaveBeenCalled();
  });

  it.each(["rejection", "nonzero exit"])(
    "retries after a %s and cleans up both attempted directories",
    async (failure) => {
      const target = sandbox();
      if (failure === "rejection") {
        target.commands.run.mockRejectedValueOnce(new Error("unavailable"));
      } else {
        target.commands.run.mockResolvedValueOnce({ exitCode: 1 });
      }
      const owner = new BrowserSessions();
      const attempts = await Promise.allSettled([
        owner.prepare(target as unknown as AnySandbox),
        owner.prepare(target as unknown as AnySandbox),
      ]);
      expect(attempts.map((attempt) => attempt.status)).toEqual([
        "rejected",
        "rejected",
      ]);
      expect(target.commands.run).toHaveBeenCalledTimes(1);
      const failedDirectory = target.commands.run.mock.calls
        .flat()
        .join(" ")
        .match(/\/dev\/shm\/hackerai-browser-[a-f0-9]+/)?.[0];
      expect(failedDirectory).toBeDefined();

      const recovered = await owner.prepare(target as unknown as AnySandbox);
      expect(recovered.AGENT_BROWSER_SOCKET_DIR).not.toContain(failedDirectory);
      expect(await owner.prepare(target as unknown as AnySandbox)).toEqual(
        recovered,
      );
      expect(target.commands.run).toHaveBeenCalledTimes(2);
      await owner.cleanup();
      expect(target.commands.run).toHaveBeenCalledTimes(4);
      const cleanupCommands = target.commands.run.mock.calls
        .slice(2)
        .flat()
        .join(" ");
      expect(cleanupCommands).toContain(failedDirectory);
      expect(cleanupCommands).toContain(
        recovered.AGENT_BROWSER_SOCKET_DIR.replace(/\/sockets$/, ""),
      );
    },
  );
});
