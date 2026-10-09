import { randomUUID } from "node:crypto";
import { metrics, type MeterProvider } from "@opentelemetry/api";
import {
  createTerminalRecordStore,
  terminalSandboxInstance,
} from "../terminal-execution-record";
import { recordTerminalMaintenance } from "@/lib/centrifugo/terminal-maintenance-metrics";

type Sample = { name: string; value: number; labels: Record<string, string> };
let samples: Sample[];
function installProvider(throws = false) {
  metrics.disable();
  metrics.setGlobalMeterProvider({
    getMeter: () => ({
      createCounter: (name: string) => ({
        add: (value: number, labels: Record<string, string>) => {
          if (throws) throw new Error("exporter down");
          samples.push({ name, value, labels });
        },
      }),
    }),
  } as unknown as MeterProvider);
}
beforeEach(() => {
  samples = [];
  installProvider();
});
afterEach(() => {
  metrics.disable();
});

function fixture(windows = false, cloud = false) {
  const files = new Map<string, string>();
  const sandbox = {
    sandboxKind: cloud ? "miosa" : "centrifugo",
    sandboxId: "cloud-id",
    isWindows: () => windows,
    supportsNativeFileRelay: () => true,
    getConnectionInfo: () => ({
      connectionId: "private-connection",
      environmentId: "private-environment",
      isDesktop: true,
    }),
    getRelayTrafficSource: () => "agent-long",
    commands: {
      run: jest.fn().mockResolvedValue({
        stdout: '{"complete":true,"scanned":1,"removed":0}',
        exitCode: 0,
      }),
    },
    files: {
      read: jest.fn(async (path: string) => {
        if (!files.has(path)) throw new Error("missing private path");
        return files.get(path)!;
      }),
      write: jest.fn(async (path: string, text: string) => {
        files.set(path, text);
      }),
      list: jest.fn(async () =>
        [...files.keys()].map((path) => ({ name: path.split("/").pop()! })),
      ),
      remove: jest.fn(async (path: string) => {
        files.delete(path);
      }),
    },
  } as any;
  const store = createTerminalRecordStore(
    sandbox,
    "private-user",
    randomUUID(),
  );
  const record = {
    version: 1 as const,
    session: "abcdef12",
    sandboxInstance: terminalSandboxInstance(sandbox),
    command: "private-command",
    pid: 1,
    status: "completed" as const,
    exitCode: 0,
    exitReason: "process_exit",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    output: "private-output é漢🙂",
    outputTruncated: false,
    artifactPaths: ["/private/artifact"],
  };
  return { sandbox, store, record, files };
}
function events(operation: string) {
  return samples.filter(
    (s) => s.name.endsWith("_operations") && s.labels.operation === operation,
  );
}
function bytes(operation: string) {
  return samples.filter(
    (s) =>
      s.name.endsWith("_payload_bytes") && s.labels.operation === operation,
  );
}

test("attributes UTF-8 record writes, recovery reads and Windows retention reads without content", async () => {
  const { sandbox, store, record, files } = fixture(true);
  const path = await store.save(record);
  expect(path).not.toBeNull();
  expect(await store.read(record.session)).toEqual(record);
  await store.prune();
  const size = Buffer.byteLength(JSON.stringify(record), "utf8");
  for (const operation of [
    "checkpoint_write",
    "recovery_read",
    "retention_read",
  ]) {
    expect(bytes(operation)).toEqual([
      expect.objectContaining({
        value: size,
        labels: {
          operation,
          outcome: "success",
          transport: "native_file",
          source: "agent-long",
          reason: "none",
        },
      }),
    ]);
  }
  expect(events("prune_route")[0].labels).toMatchObject({
    outcome: "fallback",
    reason: "windows",
  });
  expect(events("prune_fallback")[0].labels.outcome).toBe("success");
  expect(sandbox.commands.run).not.toHaveBeenCalled();
  expect(files.get(path!)).toBe(JSON.stringify(record));
  const serialized = JSON.stringify(samples);
  for (const privateValue of [
    "private-user",
    "private-connection",
    "private-environment",
    "private-command",
    "private-output",
    "/private/artifact",
    path!,
  ]) {
    expect(serialized).not.toContain(privateValue);
  }
});

test("counts returned rejected payloads and write attempts on failure, without claiming missing reads transferred bytes", async () => {
  const { sandbox, store, record, files } = fixture();
  files.set(store.pathFor(record.session), "broken é");
  expect(await store.read(record.session)).toBeNull();
  expect(bytes("recovery_read")[0]).toMatchObject({
    value: Buffer.byteLength("broken é"),
    labels: { outcome: "rejected" },
  });
  expect(await store.read("12345678")).toBeNull();
  expect(events("recovery_read")[1].labels.outcome).toBe("failure");
  expect(bytes("recovery_read")).toHaveLength(1);
  sandbox.files.write.mockRejectedValue(new Error("private error contents"));
  expect(await store.save(record)).toBeNull();
  expect(bytes("checkpoint_write")[0]).toMatchObject({
    value: Buffer.byteLength(JSON.stringify(record)),
    labels: { outcome: "failure" },
  });
  expect(JSON.stringify(samples)).not.toContain("private error");
});

test.each([
  ['{"complete":true}', "success", false],
  ['{"complete":false}', "incomplete", false],
  ['{"unavailable":true}', "fallback", true],
  ["invalid JSON", "failure", false],
])(
  "reports scanner outcome for %s without changing fallback behavior",
  async (stdout, outcome, fallback) => {
    const { sandbox, store, record } = fixture();
    await store.save(record);
    sandbox.commands.run.mockResolvedValue({ stdout, exitCode: 0 });
    await store.prune();
    expect(events("prune_route")[0].labels).toMatchObject({
      outcome,
      transport: "posix_command",
      reason: fallback ? "node_unavailable" : "none",
    });
    expect(sandbox.files.list).toHaveBeenCalledTimes(fallback ? 1 : 0);
    expect(events("prune_fallback")).toHaveLength(fallback ? 1 : 0);
    expect(bytes("retention_read")).toHaveLength(fallback ? 1 : 0);
    await store.prune();
    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
    expect(events("prune_route")[1].labels.outcome).toBe("throttled");
    expect(await store.read(record.session)).toEqual(record);
  },
);

test("records failed fallback listing and preserves best-effort prune behavior", async () => {
  const { sandbox, store } = fixture(true);
  sandbox.files.list.mockRejectedValue(new Error("disconnected"));
  await expect(store.prune()).resolves.toBeUndefined();
  expect(events("prune_fallback")[0].labels.outcome).toBe("failure");
});

test("exporter failure cannot break save, recovery, or retention", async () => {
  const { store, record } = fixture(true);
  installProvider(true);
  expect(await store.save(record)).not.toBeNull();
  expect(await store.read(record.session)).toEqual(record);
  await expect(store.prune()).resolves.toBeUndefined();
  expect(await store.read(record.session)).toEqual(record);
});

test("does not include cloud activity in local relay metrics", async () => {
  const { store, record } = fixture(false, true);
  await store.save(record);
  await store.read(record.session);
  await store.prune();
  expect(samples).toEqual([]);
});

test("supports late provider registration and ignores invalid payload byte values", () => {
  const { sandbox } = fixture();
  metrics.disable();
  const event = {
    operation: "checkpoint_write" as const,
    outcome: "success" as const,
    transport: "native_file" as const,
  };
  recordTerminalMaintenance(sandbox, { ...event, payloadBytes: 5 });
  installProvider();
  for (const payloadBytes of [-1, NaN, Infinity, 1.5, 0])
    recordTerminalMaintenance(sandbox, { ...event, payloadBytes });
  recordTerminalMaintenance(sandbox, { ...event, payloadBytes: 5 });
  expect(bytes("checkpoint_write")).toHaveLength(1);
  expect(bytes("checkpoint_write")[0].value).toBe(5);
});

test("measures logical payloads over the POSIX command transport and preserves chat source", async () => {
  const { sandbox, record } = fixture();
  sandbox.supportsNativeFileRelay = () => false;
  sandbox.supportsCommandStdin = () => true;
  sandbox.getRelayTrafficSource = () => "chat-handler";
  sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: "" });
  const store = createTerminalRecordStore(sandbox, "u", randomUUID());
  expect(await store.save(record)).not.toBeNull();
  sandbox.commands.run.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify(record),
  });
  expect(await store.read(record.session)).toEqual(record);
  for (const operation of ["checkpoint_write", "recovery_read"]) {
    expect(bytes(operation)[0]).toMatchObject({
      value: Buffer.byteLength(JSON.stringify(record)),
      labels: { transport: "posix_command", source: "chat-handler" },
    });
  }
  expect(sandbox.files.write).not.toHaveBeenCalled();
  expect(sandbox.files.read).not.toHaveBeenCalled();
});
