import { sendBrowserInput } from "../server";
import type { Sandbox } from "@e2b/code-interpreter";

jest.mock("server-only", () => ({}));
jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: {},
  CommandExitError: class extends Error {},
  TimeoutError: class extends Error {},
}));
jest.mock("@/lib/ai/tools/utils/e2b-cluster", () => ({
  getE2BClusterRouting: jest.fn(),
}));
jest.mock("@/lib/ai/tools/utils/sandbox-command-options", () => ({
  buildSandboxCommandOptions: () => ({ user: "root" }),
}));

const session = {
  userId: "owner",
  sandboxId: "sandbox",
  triggerRegion: null,
  directory: "/PRIVATE_SESSION",
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const events = [{ type: "input_text", text: "PRIVATE_INPUT_PASSWORD" }];

function fixture(failure?: string, original: unknown = new Error("PRIVATE")) {
  const order: string[] = [];
  const step = async (name: string) => {
    order.push(name);
    if (failure === name) throw original;
  };
  const handle = {
    sendStdin: jest.fn(async (_data: string) => step("send_stdin")),
    closeStdin: jest.fn(async () => step("close_stdin")),
    wait: jest.fn(async () => {
      await step("wait_bridge");
      return {
        exitCode: failure === "bridge_result" ? 6 : 0,
        stdout: "PRIVATE",
        stderr: "PRIVATE",
      };
    }),
  };
  const run = jest.fn(async (command: string) => {
    if (command.includes('"action":"stream_status"')) {
      await step("read_stream_port");
      return { exitCode: 0, stdout: JSON.stringify({ data: { port: 1234 } }) };
    }
    await step("start_bridge");
    return handle;
  });
  return {
    sandbox: { commands: { run } } as unknown as Sandbox,
    run,
    handle,
    order,
  };
}

const stages = [
  "read_stream_port",
  "start_bridge",
  "send_stdin",
  "close_stdin",
  "wait_bridge",
];
it.each(stages)(
  "attributes a failed input %s without changing the operation",
  async (stage) => {
    const original = Object.freeze(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("PRIVATE_CAUSE"), {
          code: "ECONNRESET",
        }),
      }),
    );
    const f = fixture(stage, original);
    const observe = jest.fn();
    await expect(
      sendBrowserInput(
        f.sandbox,
        session,
        "PRIVATE_NAME",
        events,
        undefined,
        observe,
      ),
    ).rejects.toBe(original);
    expect(f.order).toEqual(stages.slice(0, stages.indexOf(stage) + 1));
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0]).toMatchObject({
      input_diagnostic_version: 1,
      input_stage: stage,
      input_type_error_signal: "fetch_failed",
      input_transport_code: "ECONNRESET",
    });
    expect(JSON.stringify(observe.mock.calls)).not.toMatch(
      /PRIVATE|1234|fetch failed/,
    );
  },
);

it("preserves successful protected input and reports no failure", async () => {
  const f = fixture();
  const observe = jest.fn();
  await sendBrowserInput(
    f.sandbox,
    session,
    "PRIVATE_NAME",
    events,
    1234,
    observe,
  );
  expect(f.order).toEqual(stages.slice(1));
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.run.mock.calls[0][0]).not.toContain("PRIVATE_INPUT_PASSWORD");
  expect(f.handle.sendStdin).toHaveBeenCalledWith(JSON.stringify(events));
  expect(observe).not.toHaveBeenCalled();
});

it("cannot replace the original input rejection when its observer fails", async () => {
  const original = new Error("PRIVATE original");
  const f = fixture("close_stdin", original);
  await expect(
    sendBrowserInput(f.sandbox, session, "PRIVATE_NAME", events, 1234, () => {
      throw new Error("PRIVATE observer");
    }),
  ).rejects.toBe(original);
  expect(f.handle.wait).not.toHaveBeenCalled();
});

it("keeps a nonzero bridge result unavailable without exporting its output", async () => {
  const f = fixture("bridge_result");
  const observe = jest.fn();
  await expect(
    sendBrowserInput(f.sandbox, session, "PRIVATE_NAME", events, 1234, observe),
  ).rejects.toMatchObject({ state: "disconnected" });
  expect(observe.mock.calls[0][0]).toMatchObject({
    input_stage: "bridge_result",
    input_command_exit_code: 6,
  });
  expect(JSON.stringify(observe.mock.calls)).not.toContain("PRIVATE");
});
