// Explicit Redis integration suite, run by CI after redis-server installation.
// Application routing, identity, admission and acquisition are real; only provider
// and network-policy I/O are replaced. Lua executes unchanged in isolated Redis.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";

let mockSocket: string;
const encode = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
const mockCommand = (...args: unknown[]) =>
  JSON.parse(
    execFileSync(
      "redis-cli",
      ["-s", mockSocket, "--json", ...args.map(encode)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
const mockDecode = (v: unknown) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
jest.mock("../../lib/rate-limit/redis", () => ({
  createRedisClient: () => ({
    get: async (key: string) => mockDecode(mockCommand("GET", key)),
    mget: async (...keys: string[]) =>
      mockCommand("MGET", ...keys).map(mockDecode),
    set: async (
      key: string,
      value: unknown,
      opts?: { nx?: boolean; ex?: number },
    ) =>
      mockCommand(
        "SET",
        key,
        value,
        ...(opts?.nx ? ["NX"] : []),
        ...(opts?.ex ? ["EX", opts.ex] : []),
      ),
    eval: async (lua: string, keys: string[], args: unknown[]) =>
      mockCommand("EVAL", lua, keys.length, ...keys, ...args),
    exists: async (key: string) => mockCommand("EXISTS", key),
    del: async (...keys: string[]) => mockCommand("DEL", ...keys),
  }),
}));
jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    list: jest.fn(),
    getInfo: jest.fn(),
    connect: jest.fn(),
    create: jest.fn(),
    kill: jest.fn(),
  },
  Template: { getTags: jest.fn() },
  SandboxError: class extends Error {},
  TimeoutError: class extends Error {},
  NotFoundError: class extends Error {},
  AuthenticationError: class extends Error {},
  NotEnoughSpaceError: class extends Error {},
  RateLimitError: class extends Error {},
  TemplateError: class extends Error {},
  InvalidArgumentError: class extends Error {},
  CommandExitError: class extends Error {},
}));
jest.mock("../../lib/cloud-network/service", () => ({
  readNetworkSettings: jest.fn(async () => null),
  ensureCloudNetwork: jest.fn(async () => {}),
}));
jest.mock("../../lib/posthog/server", () => ({
  phLogger: { event: jest.fn() },
}));
jest.mock("../../lib/db/actions", () => ({
  getActiveTriggerRunsForUser: jest.fn(async () => ({
    runs: [],
    hasMore: false,
  })),
}));
jest.mock("../../lib/db/subagents", () => ({
  listActiveSubagentsForUser: jest.fn(async () => ({
    runs: [],
    hasMore: false,
  })),
}));

import { getActiveTriggerRunsForUser } from "../../lib/db/actions";
import { listActiveSubagentsForUser } from "../../lib/db/subagents";
import { Sandbox, Template } from "@e2b/code-interpreter";
import { ensureCloudSandboxConnection } from "../../lib/ai/tools/utils/cloud-sandbox";
import { resolveCloudWorkspaceRegion } from "../../lib/ai/tools/utils/cloud-workspace-routing";
import {
  workspaceRegionView,
  selectWorkspaceRegion,
} from "../../lib/ai/tools/utils/cloud-workspace-selection";
import {
  readCloudWorkspaceState,
  claimCloudWorkspaceCleanup,
  cloudWorkspaceStateKey,
  cloudWorkspaceRegionKey,
  assertCloudWorkspaceAvailable,
} from "../../lib/ai/tools/utils/cloud-workspace-guard";
import { workspaceBinding } from "../../lib/ai/tools/utils/cloud-workspace-identity";

const owner = "synthetic-owner";
type Item = {
  sandboxId: string;
  state: "running" | "paused";
  metadata: Record<string, string>;
  cluster: "us" | "eu";
  files: string;
};
let inventory: Item[];
let server: ChildProcess;
let directory: string;
const env = process.env;
const item = (id: string, cluster: "us" | "eu", tagged = true): Item => ({
  sandboxId: id,
  state: "paused",
  cluster,
  files: `retained-${id}`,
  metadata: {
    userID: owner,
    template: "terminal-agent-sandbox",
    sandboxVersion: "v12",
    ...(tagged ? { e2bCluster: cluster } : {}),
  },
});
const acquire = (
  region: "us-east-1" | "eu-central-1" = "us-east-1",
  signal?: AbortSignal,
) =>
  ensureCloudSandboxConnection({
    userId: owner,
    setSandbox: jest.fn(),
    signal,
    context: { triggerRegion: region },
  });
const state = () => readCloudWorkspaceState(owner);
const createProvider = async (_template: unknown, options: any) => {
  const created = {
    ...item(`created-${inventory.length}`, options.domain ? "eu" : "us"),
    state: "running" as const,
    metadata: options.metadata,
  };
  inventory.push(created);
  return { sandboxId: created.sandboxId } as Sandbox;
};

beforeAll(async () => {
  directory = mkdtempSync("/tmp/hai-identity-");
  mockSocket = join(directory, "redis.sock");
  server = spawn(
    "redis-server",
    [
      "--port",
      "0",
      "--unixsocket",
      mockSocket,
      "--save",
      "",
      "--appendonly",
      "no",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.stdout!.on("data", (data) => {
      if (String(data).toLowerCase().includes("ready to accept connections"))
        resolve();
    });
    server.once("exit", (code) =>
      reject(new Error(`Redis exited before readiness (${code})`)),
    );
  });
});
afterAll(async () => {
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  await exited;
  rmSync(directory, { recursive: true, force: true });
  process.env = env;
});
beforeEach(() => {
  jest.resetAllMocks();
  jest
    .mocked(getActiveTriggerRunsForUser)
    .mockResolvedValue({ runs: [], hasMore: false } as never);
  jest
    .mocked(listActiveSubagentsForUser)
    .mockResolvedValue({ runs: [], hasMore: false } as never);
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockCommand("FLUSHDB");
  inventory = [];
  process.env = {
    ...env,
    E2B_API_KEY: "test-us",
    E2B_EU_API_KEY: "test-eu",
    E2B_TEMPLATE: "terminal-agent-sandbox",
    E2B_EU_TEMPLATE: "terminal-agent-sandbox",
    CONVEX_SERVICE_ROLE_KEY: "test-key",
  };
  jest
    .mocked(Template.getTags)
    .mockResolvedValue([{ tag: "default", buildId: "test-build" }] as never);
  jest.mocked(Sandbox.list).mockImplementation(
    (options: any) =>
      ({
        hasNext: false,
        nextItems: async () =>
          inventory.filter(
            (candidate) =>
              candidate.cluster === (options?.domain ? "eu" : "us") &&
              Object.entries(options.query.metadata).every(
                ([key, value]) => candidate.metadata[key] === value,
              ),
          ),
      }) as never,
  );
  jest.mocked(Sandbox.getInfo).mockImplementation(async (id, options) => {
    const found = inventory.find(
      (candidate) =>
        candidate.sandboxId === id &&
        candidate.cluster === (options?.domain ? "eu" : "us"),
    );
    if (!found) throw new Error("not found");
    return found as never;
  });
  jest
    .mocked(Sandbox.connect)
    .mockImplementation(async (id) => ({ sandboxId: id }) as Sandbox);
  jest.mocked(Sandbox.create).mockImplementation(createProvider as never);
});
afterEach(() => jest.restoreAllMocks());

it("adopts exact legacy files across regions, ignoring subsequent inventory order and geography", async () => {
  inventory = [item("legacy-us", "us", false)];
  expect((await acquire("eu-central-1")).sandbox.sandboxId).toBe("legacy-us");
  inventory.unshift(item("newer-us", "us"), item("eu-files", "eu"));
  expect((await acquire("eu-central-1")).sandbox.sandboxId).toBe("legacy-us");
  expect(await state()).toMatchObject({
    destinationId: "legacy-us",
    region: "us-east-1",
  });
  expect(inventory.find((x) => x.sandboxId === "legacy-us")?.files).toBe(
    "retained-legacy-us",
  );
  expect(Sandbox.create).not.toHaveBeenCalled();
  expect(Sandbox.kill).not.toHaveBeenCalled();
});

it("serializes simultaneous first requests from different regions into one provider create", async () => {
  const results = await Promise.allSettled([
    acquire("us-east-1"),
    acquire("eu-central-1"),
    acquire("us-east-1"),
  ]);
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  expect(Sandbox.create).toHaveBeenCalledTimes(1);
  const first = inventory[0].sandboxId;
  expect((await acquire("eu-central-1")).sandbox.sandboxId).toBe(first);
  expect((await acquire("us-east-1")).sandbox.sandboxId).toBe(first);
  expect(Sandbox.create).toHaveBeenCalledTimes(1);
});

it("reconciles a create whose successful provider result was lost, without a second create", async () => {
  jest.mocked(Sandbox.create).mockImplementationOnce((async (
    ...args: Parameters<typeof createProvider>
  ) => {
    await createProvider(...args);
    throw new Error("response lost");
  }) as never);
  await expect(acquire()).rejects.toThrow();
  expect(await state()).toMatchObject({
    phase: "provisioning",
    step: "creating",
  });
  expect((await acquire("eu-central-1")).sandbox.sandboxId).toBe(
    inventory[0].sandboxId,
  );
  expect(await state()).toMatchObject({
    phase: "e2b",
    destinationId: inventory[0].sandboxId,
  });
  expect(Sandbox.create).toHaveBeenCalledTimes(1);
  expect(jest.mocked(Sandbox.create).mock.calls[0][1]).toMatchObject({
    retries: 0,
  });
});

it("keeps an unknown create outcome fenced when no exact token match exists", async () => {
  jest.mocked(Sandbox.create).mockRejectedValue(new Error("unknown outcome"));
  await expect(acquire()).rejects.toThrow();
  inventory.push(item("unrelated", "us"));
  await expect(acquire()).rejects.toThrow();
  await expect(claimCloudWorkspaceCleanup(owner, false)).rejects.toThrow();
  expect(Sandbox.create).toHaveBeenCalledTimes(1);
  expect(Sandbox.connect).not.toHaveBeenCalled();
  expect(await state()).toMatchObject({
    phase: "provisioning",
    step: "creating",
  });
});

it("saves a late successful creation after cancellation before allowing a retry", async () => {
  const controller = new AbortController();
  jest.mocked(Sandbox.create).mockImplementationOnce((async (
    ...args: Parameters<typeof createProvider>
  ) => {
    controller.abort(new Error("cancelled"));
    return createProvider(...args);
  }) as never);
  await expect(acquire("us-east-1", controller.signal)).rejects.toThrow(
    "cancelled",
  );
  expect(await state()).toMatchObject({
    phase: "e2b",
    destinationId: inventory[0].sandboxId,
  });
  expect((await acquire()).sandbox.sandboxId).toBe(inventory[0].sandboxId);
  expect(Sandbox.create).toHaveBeenCalledTimes(1);
});

it("preserves ambiguous same-region and cross-region inventories without connecting or creating", async () => {
  inventory = [item("one", "eu"), item("two", "eu"), item("three", "us")];
  await expect(acquire()).rejects.toThrow();
  mockCommand("SET", cloudWorkspaceRegionKey(owner), "eu-central-1");
  await expect(acquire()).rejects.toThrow();
  expect(Sandbox.create).not.toHaveBeenCalled();
  expect(Sandbox.connect).not.toHaveBeenCalled();
  expect(Sandbox.kill).not.toHaveBeenCalled();
  expect(await state()).toBeNull();
  expect(inventory.map((x) => x.files)).toEqual([
    "retained-one",
    "retained-two",
    "retained-three",
  ]);
});

it("pins the exact workspace chosen by the owner even if another appears later", async () => {
  inventory = [item("one", "us", false), item("two", "eu")];
  const view = await workspaceRegionView(owner);
  if (view.status !== "selection_required") throw Error("expected choices");
  await selectWorkspaceRegion(owner, "eu-central-1", view.token);
  inventory.unshift(item("new-eu", "eu"));
  expect((await acquire()).sandbox.sandboxId).toBe("two");
  expect(Sandbox.create).not.toHaveBeenCalled();
  expect(Sandbox.kill).not.toHaveBeenCalled();
});

it.each(["missing", "wrong-owner", "wrong-id"])(
  "never replaces a pinned workspace when it is %s",
  async (failure) => {
    const binding = workspaceBinding("original", "us-east-1", "adopted");
    mockCommand("SET", cloudWorkspaceStateKey(owner), binding);
    mockCommand("SET", cloudWorkspaceRegionKey(owner), binding.region);
    inventory = failure === "missing" ? [] : [item("original", "us")];
    if (failure === "wrong-owner")
      inventory[0].metadata.userID = "someone-else";
    if (failure === "wrong-id")
      jest
        .mocked(Sandbox.getInfo)
        .mockResolvedValue({ ...item("different", "us") } as never);
    await expect(acquire()).rejects.toThrow();
    expect(Sandbox.create).not.toHaveBeenCalled();
    expect(Sandbox.connect).not.toHaveBeenCalled();
    expect(Sandbox.kill).not.toHaveBeenCalled();
    expect(await state()).toEqual(binding);
  },
);

it("does not create after cleanup wins against a reserved first workspace", async () => {
  await resolveCloudWorkspaceRegion({
    userId: owner,
    preferredRegion: "us-east-1",
  });
  const cleanup = await claimCloudWorkspaceCleanup(owner, false);
  await expect(acquire()).rejects.toThrow();
  expect(Sandbox.create).not.toHaveBeenCalled();
  await cleanup.finish(false);
  await acquire();
  expect(Sandbox.create).toHaveBeenCalledTimes(1);
});

it("rejects cached commands for another workspace after binding", async () => {
  inventory = [item("original", "eu")];
  await acquire();
  await expect(assertCloudWorkspaceAvailable(owner, "other")).rejects.toThrow();
  await expect(
    assertCloudWorkspaceAvailable(owner, "original"),
  ).resolves.toBeUndefined();
});

it("does not create when another region becomes occupied after reservation", async () => {
  await resolveCloudWorkspaceRegion({
    userId: owner,
    preferredRegion: "us-east-1",
  });
  inventory.push(item("late-eu", "eu"));
  await expect(acquire()).rejects.toThrow();
  expect(Sandbox.create).not.toHaveBeenCalled();
  expect(Sandbox.connect).not.toHaveBeenCalled();
  expect(inventory[0].files).toBe("retained-late-eu");
});

it("does not treat a missing legacy workspace as a new account", async () => {
  mockCommand("SET", cloudWorkspaceRegionKey(owner), "us-east-1");
  await expect(acquire()).rejects.toThrow();
  expect(await state()).toBeNull();
  expect(Sandbox.create).not.toHaveBeenCalled();
});

it("keeps an older image's files instead of replacing it with a current template", async () => {
  inventory = [item("old-image", "eu")];
  inventory[0].metadata.sandboxVersion = "v10";
  expect((await acquire()).sandbox.sandboxId).toBe("old-image");
  expect((await acquire("eu-central-1")).sandbox.sandboxId).toBe("old-image");
  expect(Sandbox.create).not.toHaveBeenCalled();
  expect(Sandbox.kill).not.toHaveBeenCalled();
});

it("rejects two workspaces claiming one uncertain creation token", async () => {
  jest.mocked(Sandbox.create).mockImplementationOnce((async (
    ...args: Parameters<typeof createProvider>
  ) => {
    await createProvider(...args);
    await createProvider(...args);
    throw new Error("ambiguous outcome");
  }) as never);
  await expect(acquire()).rejects.toThrow();
  await expect(acquire()).rejects.toThrow();
  expect(Sandbox.create).toHaveBeenCalledTimes(1);
  expect(Sandbox.connect).not.toHaveBeenCalled();
  expect(await state()).toMatchObject({
    phase: "provisioning",
    step: "creating",
  });
});

it.each(["E2B_API_KEY", "E2B_EU_API_KEY"])(
  "blocks discovery when %s is missing rather than assuming that region is empty",
  async (key) => {
    delete process.env[key];
    await expect(acquire()).rejects.toThrow();
    expect(Sandbox.create).not.toHaveBeenCalled();
    expect(await state()).toBeNull();
  },
);
