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
  await sessions.prepare({
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
  return { sessions, handle, run, read };
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

it("abandons a prepared remote browser when human takeover starts before activation", async () => {
  const { sessions, handle } = await owner();
  const browser = await sessions.getChallengeBrowser(
    new AbortController().signal,
  );
  let finishClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  const close = jest.fn(async () => {
    finishClose();
  });
  handle.wait.mockImplementationOnce(async () => {
    mockQuery.mockResolvedValue({ runActive: true, state: "claiming" });
    return { exitCode: 0, stdout: JSON.stringify({ adopted: true }) };
  });
  handle.wait.mockResolvedValue({ exitCode: 0, stdout: '{"restored":true}' });
  await expect(
    browser.adoptRemote(
      { url: "https://example.com/demo", documentId: "old-page" },
      async () => ({ endpoint: "ws://127.0.0.1:12345/", close, closed }),
    ),
  ).rejects.toThrow("Browser adoption failed");
  expect(handle.sendStdin).toHaveBeenCalledTimes(2); // prepare, then safe restoration
  expect(JSON.parse(handle.sendStdin.mock.calls[0][0]).phase).toBe("prepare");
  expect(close).toHaveBeenCalledTimes(1);
  await sessions.cleanup();
});

it("cleans up an adopted remote browser with the owning run", async () => {
  const { sessions, handle } = await owner();
  handle.wait.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({ adopted: true }),
  });
  const browser = await sessions.getChallengeBrowser(
    new AbortController().signal,
  );
  let finishClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  const close = jest.fn(async () => {
    finishClose();
  });
  await browser.adoptRemote(
    { url: "https://example.com/demo", documentId: "old-page" },
    async () => ({ endpoint: "ws://127.0.0.1:12345/", close, closed }),
  );
  expect(
    handle.sendStdin.mock.calls.map((call) => JSON.parse(call[0]).phase),
  ).toEqual(["prepare", "activate"]);
  await sessions.cleanup();
  await sessions.cleanup();
  expect(close).toHaveBeenCalledTimes(1);
});

it("restores the original session after tunnel expiry waits for activation", async () => {
  const { sessions, handle } = await owner();
  let expire!: () => void;
  const closed = new Promise<void>((resolve) => {
    expire = resolve;
  });
  let activated!: () => void;
  let activate!: () => void;
  const activationStarted = new Promise<void>((resolve) => {
    activated = resolve;
  });
  const activation = new Promise<void>((resolve) => {
    activate = resolve;
  });
  handle.wait.mockResolvedValue({ exitCode: 0, stdout: '{"restored":true}' });
  handle.wait.mockResolvedValueOnce({
    exitCode: 0,
    stdout: '{"adopted":true}',
  });
  handle.wait.mockImplementationOnce(async () => {
    activated();
    await activation;
    return { exitCode: 0, stdout: '{"adopted":true}' };
  });
  let restored!: () => void;
  const restoreSent = new Promise<void>((resolve) => {
    restored = resolve;
  });
  handle.sendStdin.mockImplementation(async (input) => {
    if (!JSON.parse(input).phase) restored();
  });
  const browser = await sessions.getChallengeBrowser(
    new AbortController().signal,
  );
  const adopting = browser.adoptRemote(
    { url: "https://example.com/demo", documentId: "old-page" },
    async () => ({
      endpoint: "ws://127.0.0.1:12345/",
      closed,
      close: async () => {
        expire();
      },
    }),
  );
  await activationStarted;
  expire();
  await Promise.resolve();
  expect(handle.sendStdin).toHaveBeenCalledTimes(2);
  activate();
  await adopting;
  await restoreSent;
  expect(JSON.parse(handle.sendStdin.mock.calls[2][0])).toEqual({
    name: "default",
    remoteName: expect.stringMatching(/^fallback-/),
  });
  await sessions.cleanup();
});

it("passes response material only through stdin and returns the bounded result", async () => {
  const { sessions, run, handle, read } = await owner();
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
  expect(calls).not.toContain("AGENT_BROWSER_ENCRYPTION_KEY");
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
