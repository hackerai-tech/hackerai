import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { AgentLongMemoryTelemetry } from "@/lib/chat/agent-long-memory-telemetry";

/** Run the actual app hook without importing its worker/network registration. */
function successHook(dependencies: Record<string, unknown>) {
  dependencies = { readAgentCgroupMemory: () => ({}), ...dependencies };
  const source = ts.createSourceFile(
    "agent-long.ts",
    fs.readFileSync(path.resolve(__dirname, "../agent-long.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let hook: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "agentLongTask" &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const options = node.initializer.arguments[0];
      if (ts.isObjectLiteralExpression(options)) {
        const property = options.properties.find(
          (p) =>
            ts.isPropertyAssignment(p) &&
            p.name.getText(source) === "onSuccess",
        );
        if (property && ts.isPropertyAssignment(property))
          hook = property.initializer;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!hook) throw new Error("App onSuccess hook not found");
  const body = ts.transpileModule(`return (${hook.getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(dependencies), body)(
    ...Object.values(dependencies),
  );
}

afterEach(() => jest.restoreAllMocks());

it("uses the source process clock and attempt on an existing checkpoint without adding emissions", () => {
  jest.spyOn(process, "uptime").mockReturnValue(2.25);
  const emit = jest.fn();
  const options = {
    runId: "run_clock_owned",
    chatId: "chat_clock_owned",
    userId: "user_clock_owned",
    attempt: 2,
    now: () => 1,
    emit,
    readMemory: () => ({
      rss: 100_000_000,
      heapTotal: 80_000_000,
      heapUsed: 50_000_000,
      external: 0,
      arrayBuffers: 0,
    }),
    readHeapLimit: () => 1_000_000_000,
  };
  const telemetry = new AgentLongMemoryTelemetry(options);
  expect(telemetry.checkpoint({ phase: "provider_request" })).toBe(true);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit.mock.calls[0][0]).toMatchObject({
    run_clock_version: 1,
    run_clock_process_instance: expect.stringMatching(/^[a-f0-9]{16}$/),
    run_clock_uptime_ms: 2250,
    run_clock_attempt: 2,
  });
  expect(telemetry.checkpoint({ phase: "provider_request" })).toBe(false);
  expect(emit).toHaveBeenCalledTimes(1);
  telemetry.dispose();
});

it("preserves an existing checkpoint when the optional source clock fails", () => {
  jest.spyOn(process, "uptime").mockImplementation(() => {
    throw new Error("owned clock failure");
  });
  const emit = jest.fn();
  const options = {
    runId: "run_owned",
    chatId: "chat_owned",
    userId: "user_owned",
    attempt: 1,
    emit,
    readMemory: () => ({
      rss: 100_000_000,
      heapTotal: 80_000_000,
      heapUsed: 50_000_000,
      external: 0,
      arrayBuffers: 0,
    }),
    readHeapLimit: () => 1_000_000_000,
  };
  const telemetry = new AgentLongMemoryTelemetry(options);
  expect(telemetry.checkpoint({ phase: "provider_request" })).toBe(true);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit.mock.calls[0][0]).not.toHaveProperty("run_clock_version");
  telemetry.dispose();
});

it("annotates the existing active span at app-hook entry before unchanged goal continuation", async () => {
  const attributes = jest.fn();
  const continuation = jest.fn(async () => undefined);
  const clock = jest.fn(() => ({
    run_clock_version: 1,
    run_clock_process_instance: "0123456789abcdef",
    run_clock_uptime_ms: 2250,
    run_clock_attempt: 2,
  }));
  const hook = successHook({
    scheduleGoalContinuation: continuation,
    trace: { getActiveSpan: () => ({ setAttributes: attributes }) },
    getAgentRunClockContext: clock,
  });
  const payload = {
    goalWorkerVersion: "pinned-version",
    privateCanary: "PRIVATE_TARGET",
  };
  await hook({
    payload,
    ctx: {
      run: { id: "run_owned" },
      attempt: { number: 2 },
      deployment: { version: "deployed-version" },
    },
  });
  expect(attributes).toHaveBeenCalledWith({
    "hackerai.app_on_success_entry.run_clock_version": 1,
    "hackerai.app_on_success_entry.run_clock_process_instance":
      "0123456789abcdef",
    "hackerai.app_on_success_entry.run_clock_uptime_ms": 2250,
    "hackerai.app_on_success_entry.run_clock_attempt": 2,
  });
  expect(attributes.mock.invocationCallOrder[0]).toBeLessThan(
    continuation.mock.invocationCallOrder[0],
  );
  expect(JSON.stringify(attributes.mock.calls)).not.toContain("PRIVATE_TARGET");
  expect(continuation).toHaveBeenCalledTimes(1);
  expect(continuation).toHaveBeenCalledWith(payload, "run_owned");
});

it.each(["span_throws", "clock_throws", "missing_span", "missing_clock"])(
  "preserves goal continuation when optional telemetry is %s",
  async (failure) => {
    const continuation = jest.fn(async () => undefined);
    const hook = successHook({
      scheduleGoalContinuation: continuation,
      trace: {
        getActiveSpan: () =>
          failure === "missing_span"
            ? undefined
            : {
                setAttributes: () => {
                  throw new Error("owned annotation failure");
                },
              },
      },
      getAgentRunClockContext: () => {
        if (failure === "clock_throws") throw new Error("owned clock failure");
        return failure === "missing_clock"
          ? undefined
          : {
              run_clock_version: 1,
              run_clock_process_instance: "0123456789abcdef",
              run_clock_uptime_ms: 1,
              run_clock_attempt: 1,
            };
      },
    });
    await hook({
      payload: {},
      ctx: {
        run: { id: "run_owned" },
        attempt: { number: 1 },
        deployment: { version: "deployed-version" },
      },
    });
    expect(continuation).toHaveBeenCalledTimes(1);
    expect(continuation).toHaveBeenCalledWith(
      { goalWorkerVersion: "deployed-version" },
      "run_owned",
    );
  },
);

it("does not swallow the original goal-continuation failure", async () => {
  const original = Object.freeze(new Error("owned continuation failure"));
  const continuation = jest.fn(async () => {
    throw original;
  });
  const hook = successHook({
    scheduleGoalContinuation: continuation,
    trace: { getActiveSpan: () => undefined },
    getAgentRunClockContext: () => undefined,
  });
  await expect(
    hook({
      payload: {},
      ctx: { run: { id: "run_owned" }, attempt: { number: 1 } },
    }),
  ).rejects.toBe(original);
  expect(continuation).toHaveBeenCalledTimes(1);
});

it.each([
  {
    cgroup_memory_version: 1,
    cgroup_memory_status: "available",
    cgroup_memory_scope: "self_membership",
    cgroup_memory_current_bytes: 236412928,
    cgroup_memory_peak_bytes: 237572096,
    cgroup_memory_limit_kind: "bounded",
    cgroup_memory_limit_bytes: 589996032,
    cgroup_lifetime_high_events: 0,
    cgroup_lifetime_max_events: 0,
    cgroup_lifetime_oom_events: 0,
    cgroup_lifetime_oom_kill_events: 0,
  },
  { cgroup_memory_version: 1, cgroup_memory_status: "unavailable" },
  { cgroup_memory_version: 1, cgroup_memory_status: "self_unverified" },
])(
  "adds final application-boundary cgroup state to the existing success span: %j",
  async (fields) => {
    const attributes = jest.fn();
    const continuation = jest.fn(async () => undefined);
    const read = jest.fn(() => fields);
    const hook = successHook({
      scheduleGoalContinuation: continuation,
      trace: { getActiveSpan: () => ({ setAttributes: attributes }) },
      getAgentRunClockContext: () => ({
        run_clock_version: 1,
        run_clock_process_instance: "0123456789abcdef",
        run_clock_uptime_ms: 2250,
        run_clock_attempt: 1,
      }),
      readAgentCgroupMemory: read,
    });
    await hook({
      payload: {},
      ctx: { run: { id: "run_owned" }, attempt: { number: 1 } },
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(attributes).toHaveBeenCalledTimes(1);
    expect(attributes.mock.calls[0][0]).toMatchObject(
      Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          `hackerai.app_on_success_entry.${key}`,
          value,
        ]),
      ),
    );
    expect(attributes.mock.calls[0][0]).toHaveProperty(
      ["hackerai.app_on_success_entry.run_clock_process_instance"],
      "0123456789abcdef",
    );
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(
      continuation.mock.invocationCallOrder[0],
    );
    expect(continuation).toHaveBeenCalledTimes(1);
  },
);

it("retains the original success clock and continuation if the optional cgroup read throws", async () => {
  const attributes = jest.fn();
  const continuation = jest.fn(async () => undefined);
  const hook = successHook({
    scheduleGoalContinuation: continuation,
    trace: { getActiveSpan: () => ({ setAttributes: attributes }) },
    getAgentRunClockContext: () => ({
      run_clock_version: 1,
      run_clock_process_instance: "0123456789abcdef",
      run_clock_uptime_ms: 2250,
      run_clock_attempt: 1,
    }),
    readAgentCgroupMemory: () => {
      throw new Error("PRIVATE_PATH_CANARY");
    },
  });
  await hook({
    payload: {},
    ctx: { run: { id: "run_owned" }, attempt: { number: 1 } },
  });
  expect(attributes).toHaveBeenCalledTimes(1);
  expect(attributes.mock.calls[0][0]).toHaveProperty(
    ["hackerai.app_on_success_entry.run_clock_version"],
    1,
  );
  expect(JSON.stringify(attributes.mock.calls)).not.toContain(
    "PRIVATE_PATH_CANARY",
  );
  expect(continuation).toHaveBeenCalledTimes(1);
});
