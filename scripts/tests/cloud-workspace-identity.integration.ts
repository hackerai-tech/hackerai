// Explicit Redis integration suite, run by CI after redis-server installation.
// Application routing, identity, admission and acquisition are real; only provider
// and network-policy I/O are replaced. Lua executes unchanged in isolated Redis.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";

let mockSocket: string;
let mockBeforeEval: (() => void | Promise<void>) | undefined;
let mockMgetCount = 0;
let mockMgetFailureAt = 0;
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
    hget: async (key: string, field: string) =>
      mockDecode(mockCommand("HGET", key, field)),
    get: async (key: string) => mockDecode(mockCommand("GET", key)),
    mget: async (...keys: string[]) => {
      if (++mockMgetCount === mockMgetFailureAt)
        throw new Error("Redis unavailable");
      return mockCommand("MGET", ...keys).map(mockDecode);
    },
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
    eval: async (lua: string, keys: string[], args: unknown[]) => {
      const hook = mockBeforeEval;
      mockBeforeEval = undefined;
      await hook?.();
      return mockCommand("EVAL", lua, keys.length, ...keys, ...args);
    },
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
import {
  workspaceOptions,
  chooseWorkspace,
} from "../../lib/ai/tools/utils/cloud-workspace-options";

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
  mockMgetCount = 0;
  mockMgetFailureAt = 0;
  mockBeforeEval = undefined;
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

async function options() {
  const view = await workspaceOptions(owner, true);
  if (view.status !== "selection_required")
    throw new Error(`Expected options: ${view.status}`);
  return view;
}

it("lets an owner select among same-region copies, switch back, and retain all files and prior bindings", async () => {
  inventory = [
    item("one", "us", false),
    item("two", "us"),
    item("three", "eu"),
  ];
  inventory[0].metadata.sandboxVersion = "v10";
  mockCommand("SET", cloudWorkspaceRegionKey(owner), "eu-central-1");
  const first = await options();
  expect(first.choices.map((x) => x.id).sort()).toEqual([
    "one",
    "three",
    "two",
  ]);
  await chooseWorkspace(owner, "two", first.token);
  const previous = await state();
  expect(await workspaceOptions(owner)).toMatchObject({
    status: "selected",
    id: "two",
    region: "us-east-1",
  });
  const next = await options();
  await chooseWorkspace(owner, "one", next.token);
  expect(await state()).toMatchObject({
    destinationId: "one",
    origin: "selected",
  });
  expect(
    mockDecode(
      mockCommand(
        "HGET",
        `cloud_workspace_selection_history:v1:${owner}`,
        previous!.token,
      ),
    ),
  ).toEqual(previous);
  expect(inventory.map((x) => x.files)).toEqual([
    "retained-one",
    "retained-two",
    "retained-three",
  ]);
  expect(Sandbox.connect).not.toHaveBeenCalled();
  expect(Sandbox.create).not.toHaveBeenCalled();
  expect(Sandbox.kill).not.toHaveBeenCalled();
});

it("rejects stale choices after another tab saves an exact identity", async () => {
  inventory = [item("one", "us"), item("two", "eu")];
  const before = await options();
  await chooseWorkspace(owner, "one", before.token);
  await expect(chooseWorkspace(owner, "two", before.token)).rejects.toThrow();
  expect(await state()).toMatchObject({ destinationId: "one" });
});

it.each([
  "active-tasks",
  "activity",
  "running",
  "recovery",
  "cleanup",
  "provisioning",
  "foreign-id",
  "inventory-change",
])(
  "preserves identity and every copy when selection becomes unsafe: %s",
  async (reason) => {
    inventory = [item("one", "us"), item("two", "eu")];
    const before = await options();
    if (reason === "active-tasks")
      jest
        .mocked(listActiveSubagentsForUser)
        .mockResolvedValue({ runs: [], hasMore: true } as never);
    if (reason === "activity")
      mockCommand(
        "SET",
        `cloud_workspace_activity:v1:${owner}`,
        "active",
        "EX",
        900,
      );
    if (reason === "running") inventory[0].state = "running";
    if (reason === "recovery")
      mockCommand("SET", `cloud_recovery_consent:v1:${owner}`, {
        status: "executing",
      });
    if (reason === "cleanup")
      mockCommand("SET", cloudWorkspaceStateKey(owner), {
        version: 1,
        phase: "cleanup",
        token: "cleanup",
      });
    if (reason === "provisioning")
      mockCommand("SET", cloudWorkspaceStateKey(owner), {
        version: 1,
        phase: "provisioning",
        step: "creating",
        token: "creating",
        region: "us-east-1",
      });
    if (reason === "inventory-change") inventory.push(item("new", "us"));
    const prior = mockCommand("GET", cloudWorkspaceStateKey(owner));
    await expect(
      chooseWorkspace(
        owner,
        reason === "foreign-id" ? "someone-elses-id" : "one",
        before.token,
      ),
    ).rejects.toThrow();
    expect(mockCommand("GET", cloudWorkspaceStateKey(owner))).toEqual(prior);
    expect(Sandbox.connect).not.toHaveBeenCalled();
    expect(Sandbox.create).not.toHaveBeenCalled();
    expect(Sandbox.kill).not.toHaveBeenCalled();
  },
);

it("makes admission and workspace switching mutually exclusive even after inventory was inspected", async () => {
  inventory = [item("one", "us"), item("two", "eu")];
  let before = await options();
  await chooseWorkspace(owner, "one", before.token);
  before = await options();
  const list = jest.mocked(Sandbox.list).getMockImplementation()!;
  jest.mocked(Sandbox.list).mockImplementation((args: any) => {
    const pager = list(args);
    return {
      ...pager,
      nextItems: async (...p: any[]) => {
        const items = await pager.nextItems(p[0]);
        // Admission wins during the provider read, before selection's atomic CAS.
        await assertCloudWorkspaceAvailable(owner, "one", "us-east-1");
        return items;
      },
    } as never;
  });
  await expect(chooseWorkspace(owner, "two", before.token)).rejects.toThrow();
  expect(await state()).toMatchObject({ destinationId: "one" });
});

it("rejects an already-resolved old worker region if selection wins before admission", async () => {
  inventory = [item("one", "us"), item("two", "eu")];
  let view = await options();
  await chooseWorkspace(owner, "one", view.token);
  const oldRegion = await resolveCloudWorkspaceRegion({
    userId: owner,
    preferredRegion: "eu-central-1",
  });
  view = await options();
  await chooseWorkspace(owner, "two", view.token);
  await expect(
    assertCloudWorkspaceAvailable(owner, "two", oldRegion),
  ).rejects.toThrow();
  await expect(
    assertCloudWorkspaceAvailable(owner, "two", "eu-central-1"),
  ).resolves.toBeUndefined();
  expect(await workspaceOptions(owner, true)).toEqual({
    status: "waiting",
    reason: "recent_activity",
  });
});

it("does not report empty or write a choice after an incomplete regional read", async () => {
  const list = jest.mocked(Sandbox.list).getMockImplementation()!;
  jest.mocked(Sandbox.list).mockImplementation((args: any) =>
    args.domain
      ? ({
          hasNext: false,
          nextItems: async () => {
            throw new Error("provider offline");
          },
        } as never)
      : list(args),
  );
  await expect(workspaceOptions(owner)).rejects.toThrow();
  expect(await state()).toBeNull();
  expect(Sandbox.create).not.toHaveBeenCalled();
});

it.each([
  "cloud_resume_failures",
  "cloud_recovery_consent",
  "cloud_workspace_recovery_result",
])(
  "preserves a concurrent %s record inserted after the preflight read",
  async (prefix) => {
    inventory = [item("one", "us"), item("two", "eu")];
    const view = await options();
    const list = jest.mocked(Sandbox.list).getMockImplementation()!;
    jest.mocked(Sandbox.list).mockImplementation((args: any) => {
      const pager = list(args);
      return {
        ...pager,
        nextItems: async (...params: any[]) => {
          const entries = await pager.nextItems(params[0]);
          mockCommand("SET", `${prefix}:v1:${owner}`, { protected: true });
          return entries;
        },
      } as never;
    });
    await expect(chooseWorkspace(owner, "two", view.token)).rejects.toThrow();
    expect(await state()).toBeNull();
    expect(mockDecode(mockCommand("GET", `${prefix}:v1:${owner}`))).toEqual({
      protected: true,
    });
  },
);

it("compares the complete prior binding by value and retains a formatted recovered receipt", async () => {
  inventory = [item("one", "us"), item("two", "eu")];
  const previous = {
    ...workspaceBinding("one", "us-east-1", "adopted"),
    sourceId: "original-snapshot",
  };
  mockCommand(
    "SET",
    cloudWorkspaceStateKey(owner),
    JSON.stringify(previous, null, 2),
  );
  mockCommand("SET", cloudWorkspaceRegionKey(owner), previous.region);
  const view = await options();
  await chooseWorkspace(owner, "two", view.token);
  expect(
    mockDecode(
      mockCommand(
        "HGET",
        `cloud_workspace_selection_history:v1:${owner}`,
        previous.token,
      ),
    ),
  ).toEqual(previous);
  expect(await state()).toMatchObject({ destinationId: "two" });
});

it("does not lose recovery metadata added to the same binding during the inventory read", async () => {
  inventory = [item("one", "us"), item("two", "eu")];
  const original = workspaceBinding("one", "us-east-1", "adopted");
  mockCommand("SET", cloudWorkspaceStateKey(owner), original);
  mockCommand("SET", cloudWorkspaceRegionKey(owner), original.region);
  const view = await options();
  const protectedBinding = {
    ...original,
    recoveryPending: { backup: "retained" },
  };
  const list = jest.mocked(Sandbox.list).getMockImplementation()!;
  jest.mocked(Sandbox.list).mockImplementation((args: any) => {
    const pager = list(args);
    return {
      ...pager,
      nextItems: async (...params: any[]) => {
        const entries = await pager.nextItems(params[0]);
        mockCommand("SET", cloudWorkspaceStateKey(owner), protectedBinding);
        return entries;
      },
    } as never;
  });
  await expect(chooseWorkspace(owner, "two", view.token)).rejects.toThrow();
  expect(await state()).toEqual(protectedBinding);
});

it("only purges archived selection receipts after successful permanent account cleanup", async () => {
  inventory = [item("one", "us"), item("two", "eu")];
  let view = await options();
  await chooseWorkspace(owner, "one", view.token);
  view = await options();
  await chooseWorkspace(owner, "two", view.token);
  const history = `cloud_workspace_selection_history:v1:${owner}`;
  const cleanup = await claimCloudWorkspaceCleanup(owner, false);
  await cleanup.finish(false);
  expect(mockCommand("EXISTS", history)).toBe(1);
  const permanent = await claimCloudWorkspaceCleanup(owner, true);
  await permanent.finish(true);
  expect(mockCommand("EXISTS", history)).toBe(0);
  expect(await state()).toMatchObject({ phase: "deleted" });
});

it("reads every inventory page before offering an exact-ID choice", async () => {
  const entries = [
    item("first", "us"),
    item("second", "us"),
    item("europe", "eu"),
  ];
  jest.mocked(Sandbox.list).mockImplementation((args: any) => {
    const pages = args.domain ? [[entries[2]]] : [[entries[0]], [entries[1]]];
    const pager = {
      hasNext: true,
      nextItems: async () => {
        const page = pages.shift()!;
        pager.hasNext = pages.length > 0;
        return page;
      },
    };
    return pager as never;
  });
  const view = await options();
  expect(view.choices.map((x) => x.id).sort()).toEqual([
    "europe",
    "first",
    "second",
  ]);
  expect(Sandbox.create).not.toHaveBeenCalled();
});

const recoveryToken = "7ad19af5-4d14-4d4b-aab7-90734610a6da";
const recoveryKeys = [
  "cloud_workspace_migration:v1:",
  "cloud_recovery_consent:v1:",
  "cloud_workspace_recovery_result:v1:",
  "cloud_resume_failures:v1:",
  "cloud_workspace_region:v1:",
  "cloud_workspace_activity:v1:",
  "cloud_recovery_history:v1:",
].map((k) => k + owner);
function completedIncident() {
  const now = Date.now();
  const target = {
    sandboxId: "us-original",
    region: "us-east-1",
    template: "terminal-agent-sandbox",
    sandboxVersion: "v12",
    attempts: [recoveryToken],
    uncertain: false,
    lastFailedAt: now - 2000,
  };
  const receipt = {
    token: recoveryToken,
    target,
    status: "executing",
    issuedAt: now - 4000,
    confirmedAt: now - 3000,
  };
  const result = {
    token: recoveryToken,
    status: "verified_ready",
    sandboxId: target.sandboxId,
    region: target.region,
    completedAt: new Date(now - 1000).toISOString(),
    backupSnapshotId: "verified-backup",
  };
  const binding = workspaceBinding(target.sandboxId, "us-east-1", "selected");
  [binding, receipt, result, target, target.region].forEach((v, i) =>
    mockCommand("SET", recoveryKeys[i], v),
  );
  return { binding, receipt, result, target };
}

it("automatically retires only completed bookkeeping while preserving exact binding and idempotent history", async () => {
  const { reconcileCompletedRecovery } =
    await import("../../lib/cloud-recovery/completed");
  const { readE2BDiskRecoveryResult, claimE2BDiskRecovery } =
    await import("../../lib/ai/tools/utils/cloud-workspace-guard");
  const { binding, result } = completedIncident();
  expect(await reconcileCompletedRecovery(owner)).toBe(true);
  expect(mockDecode(mockCommand("GET", recoveryKeys[0]))).toEqual(binding);
  expect(mockCommand("MGET", ...recoveryKeys.slice(1, 4))).toEqual([
    null,
    null,
    null,
  ]);
  expect(await readE2BDiskRecoveryResult(owner, recoveryToken)).toEqual(result);
  await expect(
    claimE2BDiskRecovery({
      userId: owner,
      sandboxId: binding.destinationId,
      region: binding.region,
      token: recoveryToken,
      operatorId: "stale-operator",
    }),
  ).rejects.toThrow();
  expect(Sandbox.connect).not.toHaveBeenCalled();
  expect(Sandbox.create).not.toHaveBeenCalled();
  expect(Sandbox.kill).not.toHaveBeenCalled();
});

it("preserves new failure evidence for fresh confirmation after a completed incident", async () => {
  const { reconcileCompletedRecovery } =
    await import("../../lib/cloud-recovery/completed");
  const { target } = completedIncident();
  const newFailure = { ...target, lastFailedAt: Date.now() };
  mockCommand("SET", recoveryKeys[3], newFailure);
  expect(await reconcileCompletedRecovery(owner)).toBe(true);
  expect(mockDecode(mockCommand("GET", recoveryKeys[3]))).toEqual(newFailure);
});

it.each([
  "new_failure",
  "new_fence",
  "activity",
  "region",
  "consent",
  "result",
])(
  "refuses completed reconciliation when %s races the snapshot",
  async (kind) => {
    const { reconcileCompletedRecovery } =
      await import("../../lib/cloud-recovery/completed");
    const fixture = completedIncident();
    mockBeforeEval = () => {
      const change = {
        new_failure: [3, { ...fixture.target, lastFailedAt: Date.now() }],
        new_fence: [
          0,
          { ...fixture.binding, recoveryPending: { unknown: true } },
        ],
        activity: [5, "active"],
        region: [4, "eu-central-1"],
        consent: [1, { ...fixture.receipt, status: "confirmed" }],
        result: [2, { ...fixture.result, status: "unknown" }],
      }[kind]!;
      mockCommand("SET", recoveryKeys[change[0] as number], change[1]);
    };
    expect(await reconcileCompletedRecovery(owner)).toBe(false);
    expect(mockCommand("EXISTS", recoveryKeys[1], recoveryKeys[2])).toBe(2);
    expect(mockCommand("EXISTS", recoveryKeys[6])).toBe(0);
  },
);

it.each([
  "unknown",
  "wrong_id",
  "missing_backup",
  "future",
  "preservation",
  "active_parent",
  "active_child",
  "has_more",
])("keeps recovery protected for %s", async (kind) => {
  const { reconcileCompletedRecovery } =
    await import("../../lib/cloud-recovery/completed");
  const f = completedIncident();
  if (kind === "unknown")
    mockCommand("SET", recoveryKeys[2], { ...f.result, status: "unknown" });
  if (kind === "wrong_id")
    mockCommand("SET", recoveryKeys[2], { ...f.result, sandboxId: "other" });
  if (kind === "missing_backup")
    mockCommand("SET", recoveryKeys[2], { ...f.result, backupSnapshotId: "" });
  if (kind === "future")
    mockCommand("SET", recoveryKeys[2], {
      ...f.result,
      completedAt: new Date(Date.now() + 60000).toISOString(),
    });
  if (kind === "preservation")
    mockCommand("SET", recoveryKeys[0], {
      ...f.binding,
      preservationHold: true,
    });
  if (kind === "active_parent" || kind === "has_more")
    jest.mocked(getActiveTriggerRunsForUser).mockResolvedValueOnce({
      runs: kind === "active_parent" ? [{}] : [],
      hasMore: kind === "has_more",
    } as never);
  if (kind === "active_child")
    jest
      .mocked(listActiveSubagentsForUser)
      .mockResolvedValueOnce({ runs: [{}], hasMore: false } as never);
  expect(await reconcileCompletedRecovery(owner)).toBe(false);
  expect(mockCommand("EXISTS", recoveryKeys[1], recoveryKeys[2])).toBe(2);
});

it("completed recovery no longer blocks management and preserves all retained copies", async () => {
  const { binding } = completedIncident();
  inventory = [
    item(binding.destinationId, "us"),
    item("other-us", "us"),
    item("other-eu", "eu"),
  ];
  const before = JSON.stringify(inventory);
  const view = await workspaceOptions(owner, true);
  expect(view.status).toBe("selection_required");
  if (view.status !== "selection_required") throw new Error("missing choices");
  expect(view.currentId).toBe(binding.destinationId);
  await chooseWorkspace(owner, "other-eu", view.token);
  expect((await readCloudWorkspaceState(owner))?.phase).toBe("e2b");
  expect(JSON.stringify(inventory)).toBe(before);
  expect(Sandbox.connect).not.toHaveBeenCalled();
  expect(Sandbox.kill).not.toHaveBeenCalled();
  expect(Sandbox.create).not.toHaveBeenCalled();
});

it.each([false, true])(
  "expired dispatch reconciliation cannot race an already-claimed worker (claimed=%s)",
  async (claimed) => {
    const { failConsent } = await import("../../lib/cloud-recovery/store");
    const { claimE2BDiskRecovery } =
      await import("../../lib/ai/tools/utils/cloud-workspace-guard");
    const f = completedIncident();
    mockCommand("DEL", recoveryKeys[2]);
    const expired = {
      ...f.receipt,
      status: "confirmed",
      confirmedAt: Date.now() - 11 * 60000,
    };
    mockCommand("SET", recoveryKeys[1], expired);
    const claim = () =>
      claimE2BDiskRecovery({
        userId: owner,
        sandboxId: f.binding.destinationId,
        region: f.binding.region,
        token: recoveryToken,
        operatorId: "customer",
        customerConsent: { key: recoveryKeys[1], token: recoveryToken },
      });
    if (claimed) await claim();
    await failConsent(owner, recoveryToken, Date.now() - 10 * 60000);
    const saved = mockDecode(mockCommand("GET", recoveryKeys[1]));
    if (claimed) {
      expect(saved.status).toBe("executing");
      expect(mockDecode(mockCommand("GET", recoveryKeys[0])).phase).toBe(
        "recovery",
      );
    } else {
      expect(saved).toMatchObject({
        status: "failed",
        failurePhase: "before_reboot",
      });
      await expect(claim()).rejects.toThrow();
    }
  },
);

it.each(["reconciliation", "reread"])(
  "keeps the protected recovery view when opportunistic %s fails",
  async (failure) => {
    completedIncident();
    if (failure === "reconciliation")
      jest
        .mocked(getActiveTriggerRunsForUser)
        .mockRejectedValueOnce(new Error("Convex unavailable"));
    else mockMgetFailureAt = 3;
    expect(await workspaceOptions(owner, true)).toEqual({
      status: "protected",
      reason: "recovery",
    });
    expect(Sandbox.connect).not.toHaveBeenCalled();
    expect(Sandbox.create).not.toHaveBeenCalled();
    expect(Sandbox.kill).not.toHaveBeenCalled();
  },
);

it.each([true, false])(
  "serializes real cloud admission with completed retirement (admission first=%s)",
  async (admissionFirst) => {
    const { reconcileCompletedRecovery } =
      await import("../../lib/cloud-recovery/completed");
    const { binding } = completedIncident();
    const admit = () =>
      assertCloudWorkspaceAvailable(
        owner,
        binding.destinationId,
        binding.region,
      );
    if (admissionFirst) mockBeforeEval = admit;
    expect(await reconcileCompletedRecovery(owner)).toBe(!admissionFirst);
    if (!admissionFirst) await admit();
    expect(mockCommand("EXISTS", recoveryKeys[5])).toBe(1);
    expect(mockCommand("EXISTS", recoveryKeys[6])).toBe(admissionFirst ? 0 : 1);
    expect(mockDecode(mockCommand("GET", recoveryKeys[0]))).toEqual(binding);
    expect(Sandbox.connect).not.toHaveBeenCalled();
    expect(Sandbox.create).not.toHaveBeenCalled();
    expect(Sandbox.kill).not.toHaveBeenCalled();
  },
);
