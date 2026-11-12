import { createCommandSessionHandle } from "../command-session-handle";

describe("command exit observation ownership", () => {
  it("still terminates a command after its exit observation failed", async () => {
    const kill = jest.fn(async () => true);
    const handle = createCommandSessionHandle({ kill });
    handle.resolveExit(null, true);
    await expect(handle.exited).resolves.toEqual({
      exitCode: null,
      observationFailed: true,
    });
    await handle.kill();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("does not kill again after a confirmed exit with an unavailable code", async () => {
    const kill = jest.fn(async () => true);
    const handle = createCommandSessionHandle({ kill });
    handle.resolveExit(null);
    await expect(handle.exited).resolves.toEqual({ exitCode: null });
    await handle.kill();
    expect(kill).not.toHaveBeenCalled();
  });
});
