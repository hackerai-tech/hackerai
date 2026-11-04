import type { AnySandbox } from "@/types";
import { BrowserSessions } from "../browser-sessions";

const mockQuery = jest.fn();
const mockMutation = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery, mutation: mockMutation }),
}));

async function owner() {
  const sessions = new BrowserSessions({
    userId: "owner",
    chatId: "chat",
    runId: "run",
    agentId: "parent",
    serviceKey: "private-service-key",
  });
  const handle = {
    sendStdin: jest.fn(async (_input: string) => {}),
    closeStdin: jest.fn(async () => {}),
    kill: jest.fn(async () => true),
    wait: jest.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        success: true,
        data: { result: { status: "token_delivered" } },
      }),
    })),
  };
  const run = jest
    .fn()
    .mockResolvedValueOnce({ exitCode: 0, stdout: "/usr/bin" });
  const read = jest.fn(async () => "default");
  const preparedEnv = await sessions.prepare({
    sandboxId: "sandbox",
    commands: { run },
    files: { read },
  } as unknown as AnySandbox);
  run.mockImplementation(async (_command, options) =>
    options.background
      ? handle
      : {
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            data: { connected: true, port: 9223 },
          }),
        },
  );
  return {
    sessions,
    handle,
    run,
    read,
    checkpointKey: preparedEnv.AGENT_BROWSER_ENCRYPTION_KEY,
  };
}
beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ runActive: true, state: "agent" });
  mockMutation.mockReset().mockResolvedValue(true);
});

it("requires an already-owned browser and never acquires or opens a new one", async () => {
  const sessions = new BrowserSessions();
  await expect(
    sessions.getChallengeBrowser(new AbortController().signal),
  ).rejects.toThrow("Open an owned Cloud browser");
  expect(mockQuery).not.toHaveBeenCalled();
});

it("passes response material only through stdin and returns the bounded result", async () => {
  const { sessions, run, handle, read, checkpointKey } = await owner();
  const browser = await sessions.getChallengeBrowser(
    new AbortController().signal,
  );
  expect(await browser.evaluate("private-response-script")).toEqual({
    status: "token_delivered",
  });
  expect(handle.sendStdin).toHaveBeenCalledWith("private-response-script");
  expect(read).toHaveBeenCalledWith(
    expect.stringMatching(/\/active-session$/),
    expect.objectContaining({
      user: "root",
      requestTimeoutMs: 8000,
      signal: expect.any(AbortSignal),
    }),
  );
  const calls = JSON.stringify(run.mock.calls);
  expect(calls).not.toContain("private-response-script");
  expect(calls).not.toContain("private-service-key");
  expect(calls.includes(checkpointKey)).toBe(false);
  for (const [, options] of run.mock.calls) {
    expect(Object.keys(options.envs ?? options.envVars ?? {})).not.toContain(
      "AGENT_BROWSER_ENCRYPTION_KEY",
    );
  }
  expect(run).toHaveBeenLastCalledWith(
    expect.stringMatching(
      /^\/tmp\/hackerai-browser-[a-f0-9]+\/bin\/agent-browser --session 'default' eval --stdin --json$/,
    ),
    expect.objectContaining({
      stdin: true,
      background: true,
      timeoutMs: 10000,
    }),
  );
});

it.each(["ended", "human", "waiting", "session changed"])(
  "refuses late delivery after %s",
  async (state) => {
    const { sessions, run, read, handle } = await owner();
    const browser = await sessions.getChallengeBrowser(
      new AbortController().signal,
    );
    if (state === "ended")
      mockQuery.mockResolvedValue({ runActive: false, state: "agent" });
    if (state === "human" || state === "waiting")
      mockQuery.mockResolvedValue({ runActive: true, state });
    if (state === "session changed") read.mockResolvedValue("other-account");
    await expect(browser.evaluate("must-not-deliver")).rejects.toThrow();
    expect(handle.sendStdin).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1); // preparation only
  },
);

it("does not restart an idle browser", async () => {
  const { sessions, run, handle } = await owner();
  const browser = await sessions.getChallengeBrowser(
    new AbortController().signal,
  );
  run.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({ success: true, data: { connected: false } }),
  });
  await expect(browser.evaluate("must-not-deliver")).rejects.toThrow(
    "no longer connected",
  );
  expect(handle.sendStdin).not.toHaveBeenCalled();
  expect(run.mock.calls.every(([, options]) => !options.background)).toBe(true);
});

it("does not send a token when ownership changes while the eval process starts", async () => {
  const { sessions, run, handle } = await owner();
  const browser = await sessions.getChallengeBrowser(
    new AbortController().signal,
  );
  run.mockImplementation(async (_command, options) => {
    if (options.background) {
      mockQuery.mockResolvedValue({ runActive: true, state: "claiming" });
      return handle;
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        success: true,
        data: { connected: true, port: 9223 },
      }),
    };
  });
  await expect(browser.evaluate("must-not-deliver")).rejects.toThrow();
  expect(handle.sendStdin).not.toHaveBeenCalled();
  expect(handle.kill).toHaveBeenCalledTimes(1);
});

it("kills a pending private eval on Stop instead of accepting a late result", async () => {
  const { sessions, handle } = await owner();
  const controller = new AbortController();
  const browser = await sessions.getChallengeBrowser(controller.signal);
  let started!: () => void;
  const waiting = new Promise<void>((done) => {
    started = done;
  });
  handle.wait.mockImplementation(() => {
    started();
    return new Promise(() => {});
  });
  const pending = browser.evaluate("private-response-script");
  const rejected = expect(pending).rejects.toThrow("stopped");
  await waiting;
  controller.abort(new Error("stopped"));
  await rejected;
  expect(handle.kill).toHaveBeenCalledTimes(1);
});
