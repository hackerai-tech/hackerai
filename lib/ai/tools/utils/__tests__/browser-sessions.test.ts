import type { AnySandbox } from "@/types";
import { BrowserSessions } from "../browser-sessions";

function sandbox() {
  return {
    sandboxId: "test-sandbox",
    commands: { run: jest.fn(async () => ({ exitCode: 0 })) },
  };
}

describe("managed browser ownership", () => {
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
});
