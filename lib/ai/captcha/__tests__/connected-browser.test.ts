import type { AnySandbox } from "@/types";
import { BrowserSessions } from "../../tools/utils/browser-sessions";

function connection(id = "connection", desktop = false) {
  const run = jest.fn(async (_command: string, options: { stdin: string }) => {
    const input = JSON.parse(options.stdin).request;
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        input.action === "prepare"
          ? {
              root: `/tmp/hackerai-captcha-${input.owner}`,
              name: `captcha-${input.owner}`,
            }
          : {
              ok: true,
              result: { status: "token_delivered", websiteAccepted: false },
            },
      ),
      stderr: "",
    };
  });
  const sandbox = {
    sandboxKind: "centrifugo",
    commands: { run },
    getConnectionInfo: () => ({ connectionId: id, isDesktop: desktop }),
    supportsCommandStdin: () => true,
    isWindows: () => false,
  } as unknown as AnySandbox;
  return { sandbox, run };
}

it.each([false, true])(
  "keeps response tokens out of commands and survives reconnect (desktop=%s)",
  async (desktop) => {
    const sessions = new BrowserSessions(undefined, undefined, true);
    const first = connection("one", desktop);
    const env = await sessions.prepare(first.sandbox);
    const reconnected = connection("one", desktop);
    expect(await sessions.prepare(reconnected.sandbox)).toEqual(env);
    expect(reconnected.run).not.toHaveBeenCalled();
    const browser = await sessions.getChallengeBrowser(
      new AbortController().signal,
    );
    const secret = "synthetic-response-token";
    expect(await browser.evaluate(secret)).toEqual({
      status: "token_delivered",
      websiteAccepted: false,
    });
    const [command, options] = reconnected.run.mock.calls[0];
    expect(command).not.toContain(secret);
    expect(JSON.parse(options.stdin).request.script).toBe(secret);
    expect(options).not.toHaveProperty("onStdout");
    expect(options).not.toHaveProperty("envVars");
    await sessions.cleanup();
    await expect(browser.evaluate(secret)).rejects.toThrow("ownership ended");
    expect(
      JSON.parse(reconnected.run.mock.calls[1][1].stdin).request.action,
    ).toBe("cleanup");
  },
);

it("does not inspect user browsers or enable connected changes outside the Preview gate", async () => {
  const target = connection();
  const disabled = new BrowserSessions();
  expect(await disabled.prepare(target.sandbox)).toEqual({});
  const enabled = new BrowserSessions(undefined, undefined, true);
  await expect(
    enabled.getChallengeBrowser(new AbortController().signal),
  ).rejects.toThrow("Open an owned");
  expect(target.run).not.toHaveBeenCalled();
});

it("isolates browser namespaces between runs and connected machines", async () => {
  const a = new BrowserSessions(undefined, undefined, true);
  const b = new BrowserSessions(undefined, undefined, true);
  const envs = await Promise.all([
    a.prepare(connection("one").sandbox),
    a.prepare(connection("two").sandbox),
    b.prepare(connection("one").sandbox),
  ]);
  expect(new Set(envs.map((env) => env.AGENT_BROWSER_SESSION)).size).toBe(3);
  expect(new Set(envs.map((env) => env.AGENT_BROWSER_SOCKET_DIR)).size).toBe(3);
  await Promise.all([a.cleanup(), b.cleanup()]);
});

it("uses the snapshot connection and name after another connection becomes active", async () => {
  const sessions = new BrowserSessions(undefined, undefined, true);
  const first = connection("snapshot-connection");
  const second = connection("later-connection");
  await sessions.prepare(first.sandbox);
  await sessions.prepare(second.sandbox);
  const browser = await sessions.getChallengeBrowser(
    new AbortController().signal,
    {
      sandbox: first.sandbox,
      sessionName: "snapshot-name",
    },
  );
  await browser.evaluate("document.title");
  expect(JSON.parse(first.run.mock.calls[1][1].stdin).request.sessionName).toBe(
    "snapshot-name",
  );
  expect(second.run).toHaveBeenCalledTimes(1);
  await sessions.cleanup();
});

it("does not expose raw transport errors and never retries response delivery", async () => {
  const target = connection();
  const sessions = new BrowserSessions(undefined, undefined, true);
  await sessions.prepare(target.sandbox);
  const browser = await sessions.getChallengeBrowser(
    new AbortController().signal,
  );
  target.run.mockRejectedValueOnce(
    new Error("provider-key synthetic-response-token"),
  );
  await expect(browser.evaluate("synthetic-response-token")).rejects.toThrow(
    "Owned connected browser unavailable.",
  );
  expect(target.run).toHaveBeenCalledTimes(2);
  await sessions.cleanup();
});

it("keeps terminal execution available when optional browser setup fails", async () => {
  const target = connection();
  target.run.mockRejectedValueOnce(new Error("Node unavailable"));
  const sessions = new BrowserSessions(undefined, undefined, true);
  expect(await sessions.prepare(target.sandbox)).toEqual({});
  await expect(
    sessions.getChallengeBrowser(new AbortController().signal),
  ).rejects.toThrow("Owned connected browser unavailable");
  expect(await sessions.prepare(target.sandbox)).toEqual({});
  expect(target.run).toHaveBeenCalledTimes(1);
  await sessions.cleanup();
});

it("does not retain the previous connection when switching to an unsupported client", async () => {
  const sessions = new BrowserSessions(undefined, undefined, true);
  await sessions.prepare(connection("first").sandbox);
  const unsupported = connection("second");
  Object.assign(unsupported.sandbox, { supportsCommandStdin: () => false });
  expect(await sessions.prepare(unsupported.sandbox)).toEqual({});
  await expect(
    sessions.getChallengeBrowser(new AbortController().signal),
  ).rejects.toThrow("Open an owned connected browser first");
  expect(unsupported.run).not.toHaveBeenCalled();
  await sessions.cleanup();
});
