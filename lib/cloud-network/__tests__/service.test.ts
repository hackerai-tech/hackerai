import { Sandbox } from "@e2b/code-interpreter";
import { getConvexClient } from "@/lib/db/convex-client";
import {
  ensureCloudNetwork,
  NetworkSettingsError,
  saveNetworkSettings,
  type CloudNetworkSuboperation,
  type ReportCloudNetworkSuboperation,
} from "../service";
import { normalizeNetworkPolicy, type NetworkPolicy } from "../policy";
import { ConvexError } from "convex/values";
import { ensureSandboxConnection } from "@/lib/ai/tools/utils/sandbox";
import { startWorkspaceCreation } from "@/lib/ai/tools/utils/cloud-workspace-identity";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  managedEgressForCluster,
  resolveManagedEgress,
} from "../managed-egress";
import fixture from "../../../scripts/egress/tests/credentials.json";

jest.mock("@e2b/code-interpreter", () => {
  class E2BError extends Error {}
  return {
    Sandbox: {
      list: jest.fn(),
      connect: jest.fn(),
      getInfo: jest.fn(),
      create: jest.fn(),
      kill: jest.fn(),
    },
    Template: {
      getTags: jest.fn(async () => [{ tag: "default", buildId: "build-1" }]),
    },
    SandboxError: E2BError,
    TimeoutError: class extends E2BError {},
    NotFoundError: class extends E2BError {},
    AuthenticationError: class extends E2BError {},
    NotEnoughSpaceError: class extends E2BError {},
    RateLimitError: class extends E2BError {},
    TemplateError: class extends E2BError {},
    InvalidArgumentError: class extends E2BError {},
    CommandExitError: class extends E2BError {},
  };
});
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));
// The real Trigger region to E2B cluster routing, configured below with
// synthetic values: only the US cluster unless a test enables EU.
const EU_DOMAIN = "eu-e2b.example.test";
const originalEnv = process.env;
const CONFIGURED_ENV = [
  "E2B_EU_API_KEY",
  "E2B_EU_DOMAIN",
  "E2B_TEMPLATE",
  "E2B_EU_TEMPLATE",
  "E2B_MANAGED_EGRESS_ENABLED",
  "E2B_MANAGED_EGRESS_USERS",
  "E2B_MANAGED_EGRESS_US_PROXY",
  "E2B_MANAGED_EGRESS_EU_PROXY",
  "E2B_MANAGED_EGRESS_DESTINATIONS",
  "E2B_EGRESS_ATTRIBUTION_ENABLED",
  "E2B_EGRESS_ATTRIBUTION_USERS",
  "E2B_EGRESS_ATTRIBUTION_US_KEY",
  "E2B_EGRESS_ATTRIBUTION_EU_KEY",
  "E2B_EGRESS_TELEMETRY_US_KEY",
  "E2B_EGRESS_TELEMETRY_EU_KEY",
];
beforeEach(() => {
  process.env = { ...originalEnv, E2B_API_KEY: "synthetic-us-key" };
  for (const name of CONFIGURED_ENV) delete process.env[name];
});
afterAll(() => {
  process.env = originalEnv;
});
function enableEuCluster() {
  process.env.E2B_EU_API_KEY = "synthetic-eu-key";
  process.env.E2B_EU_DOMAIN = EU_DOMAIN;
}
jest.mock("@/lib/ai/tools/utils/cloud-workspace-guard", () => ({
  assertCloudWorkspaceAvailable: jest.fn(),
  readCloudWorkspaceState: jest.fn(async () => null),
  refreshE2BWorkspaceLease: jest.fn(),
  CloudWorkspaceUnavailableError: class extends Error {},
}));
jest.mock("@/lib/ai/tools/utils/cloud-workspace-identity", () => ({
  listWorkspaceInventory: jest.fn(async () => []),
  startWorkspaceCreation: jest.fn(async (_user: string, reserved: object) => ({
    ...reserved,
    step: "creating",
  })),
  finishWorkspaceCreation: jest.fn(async () => {}),
}));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanMakeCostIncurringRequest: jest.fn(async () => {}),
}));
jest.mock("@/lib/cloud-recovery/store", () => ({
  recordResumeFailure: jest.fn(async () => {}),
  clearResumeFailures: jest.fn(async () => {}),
}));
const policy = { mode: "restricted" as const, allow: ["api.example.test"] };
const mutation = jest.fn();
const query = jest.fn();
type ProviderNetwork = {
  allowOut: string[];
  denyOut: string[];
  egressProxy?: { address: string; username?: string; password?: string };
  rules?: Record<string, unknown[]>;
};
/** Fake E2B workspace: like the provider, readback never returns the password. */
function workspace(
  owner = "owner",
  initial: ProviderNetwork = { allowOut: [], denyOut: [] },
  sandboxId = "existing",
) {
  let network = initial;
  const files = new Map([["/home/user/keep.txt", "unchanged-file"]]);
  return {
    sandboxId,
    files,
    getInfo: jest.fn(async (): Promise<unknown> => {
      const { egressProxy, ...rest } = network;
      return {
        metadata: { userID: owner },
        network: {
          ...rest,
          ...(egressProxy && {
            egressProxy: {
              address: egressProxy.address,
              username: egressProxy.username,
            },
          }),
        },
      };
    }),
    updateNetwork: jest.fn(async (value: ProviderNetwork) => {
      network = value;
    }),
  };
}
const appliedPolicy = () => ({
  allowOut: [...policy.allow],
  denyOut: ["0.0.0.0/0"],
});
function resetMocks() {
  jest.clearAllMocks();
  (getConvexClient as jest.Mock).mockReturnValue({ mutation, query });
  mutation
    .mockReset()
    .mockResolvedValueOnce({ policy, revision: 2, status: "applying" })
    .mockResolvedValue(null);
  query.mockReset().mockResolvedValue({ policy, revision: 2, status: "ready" });
  (Sandbox.list as jest.Mock).mockReturnValue({
    nextItems: async () => [
      { sandboxId: "existing", metadata: { userID: "owner" } },
    ],
    hasNext: false,
  });
}
beforeEach(resetMocks);
it("updates and verifies the existing workspace without deleting, recreating, or writing its files", async () => {
  const sandbox = workspace();
  (Sandbox.connect as jest.Mock).mockResolvedValue(sandbox);
  const result = await saveNetworkSettings("owner", policy, 1);
  expect(result?.status).toBe("ready");
  expect(sandbox.updateNetwork).toHaveBeenCalledWith(
    { allowOut: ["api.example.test"], denyOut: ["0.0.0.0/0"] },
    expect.anything(),
  );
  expect(sandbox.files.get("/home/user/keep.txt")).toBe("unchanged-file");
  expect(Sandbox.create).not.toHaveBeenCalled();
  expect(Sandbox.kill).not.toHaveBeenCalled();
  expect(mutation.mock.calls[1][1]).toMatchObject({ success: true });
});
it.each(["provider failure", "readback mismatch", "wrong owner"])(
  "does not report success on %s",
  async (failure) => {
    const sandbox = workspace(failure === "wrong owner" ? "other" : "owner");
    if (failure === "provider failure")
      sandbox.updateNetwork.mockRejectedValueOnce(
        new Error("private provider detail"),
      );
    if (failure === "readback mismatch")
      sandbox.updateNetwork.mockImplementationOnce(async () => {});
    (Sandbox.connect as jest.Mock).mockResolvedValue(sandbox);
    await expect(saveNetworkSettings("owner", policy, 1)).rejects.toThrow(
      "could not be verified",
    );
    expect(mutation.mock.calls[1][1]).toMatchObject({
      success: false,
      releaseLease: failure === "wrong owner",
    });
  },
);
it("does not contact the provider after a concurrent-save conflict", async () => {
  mutation
    .mockReset()
    .mockRejectedValueOnce(
      new ConvexError("Network settings changed. Reload them before saving."),
    );
  await expect(saveNetworkSettings("owner", policy, 1)).rejects.toMatchObject({
    status: 409,
  });
  expect(Sandbox.list).not.toHaveBeenCalled();
});
it("applies saved rules to a newly connected sandbox before returning it", async () => {
  const sandbox = workspace();
  await ensureCloudNetwork(sandbox as any, "owner", "us");
  expect(sandbox.updateNetwork).toHaveBeenCalled();
  expect(Sandbox.connect).not.toHaveBeenCalled();
  sandbox.updateNetwork.mockClear();
  await ensureCloudNetwork(sandbox as any, "owner", "us");
  expect(sandbox.updateNetwork).not.toHaveBeenCalled();
});
it("keeps default workspaces unchanged and fails closed on storage failure", async () => {
  const sandbox = workspace();
  query.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  await ensureCloudNetwork(sandbox as any, "owner", "us");
  expect(sandbox.updateNetwork).not.toHaveBeenCalled();
  query.mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(
    ensureCloudNetwork(sandbox as any, "owner", "us"),
  ).rejects.toThrow();
});
it("reconciles inherited deny-all rules with the unsaved Internet access default without replacing the workspace", async () => {
  const sandbox = workspace();
  await sandbox.updateNetwork({ allowOut: [], denyOut: ["0.0.0.0/0"] });
  sandbox.updateNetwork.mockClear();
  query.mockResolvedValue(null);
  const defaultPolicy = { mode: "unrestricted", allow: [] };
  mutation
    .mockReset()
    .mockResolvedValueOnce({
      policy: defaultPolicy,
      revision: 1,
      status: "applying",
    })
    .mockResolvedValue(null);

  await ensureCloudNetwork(sandbox as any, "owner", "us");

  expect(mutation).toHaveBeenNthCalledWith(
    1,
    expect.anything(),
    expect.objectContaining({ policy: defaultPolicy, expectedRevision: 0 }),
  );
  expect(sandbox.updateNetwork).toHaveBeenCalledWith(
    { allowOut: [], denyOut: [] },
    expect.anything(),
  );
  expect(mutation.mock.calls[1][1]).toMatchObject({ success: true });
  expect(sandbox.files.get("/home/user/keep.txt")).toBe("unchanged-file");
  expect(Sandbox.create).not.toHaveBeenCalled();
  expect(Sandbox.kill).not.toHaveBeenCalled();
});
it("does not overwrite a concurrently saved policy while reconciling an unsaved default", async () => {
  const sandbox = workspace();
  await sandbox.updateNetwork({ allowOut: [], denyOut: ["0.0.0.0/0"] });
  sandbox.updateNetwork.mockClear();
  query.mockResolvedValue(null);
  mutation
    .mockReset()
    .mockRejectedValueOnce(
      new ConvexError("Network settings changed. Reload them before saving."),
    );

  await expect(
    ensureCloudNetwork(sandbox as any, "owner", "us"),
  ).rejects.toMatchObject({ status: 409 });

  expect(mutation).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ expectedRevision: 0 }),
  );
  expect(sandbox.updateNetwork).not.toHaveBeenCalled();
});
it.each([
  "https://example.test/api",
  "example.test:8443",
  "127.1",
  "0x7f000001",
  "*.127.0.0.1",
  "192.0.2.0/33",
  "[::1]",
  "https://example.test",
  "example.test:443",
  "*.0x7f000001",
])("rejects an unrepresentable destination %s", (destination) => {
  expect(() =>
    normalizeNetworkPolicy({ mode: "restricted", allow: [destination] }),
  ).toThrow();
});
it("normalizes destinations and clears stale allow entries when disabling internet", () => {
  expect(
    normalizeNetworkPolicy({
      mode: "restricted",
      allow: ["API.example.test", "api.example.test", "192.0.2.0/24"],
    }).allow,
  ).toEqual(["192.0.2.0/24", "api.example.test"]);
  expect(
    normalizeNetworkPolicy({ mode: "offline", allow: ["api.example.test"] }),
  ).toEqual({ mode: "offline", allow: [] });
});

it("allows concurrent acquisitions of an already applied policy without taking the writer lease", async () => {
  const a = workspace(),
    b = workspace();
  for (const sandbox of [a, b])
    await sandbox.updateNetwork({
      allowOut: policy.allow,
      denyOut: ["0.0.0.0/0"],
    });
  await Promise.all([
    ensureCloudNetwork(a as any, "owner", "us"),
    ensureCloudNetwork(b as any, "owner", "us"),
  ]);
  expect(mutation).not.toHaveBeenCalled();
});
it("does not cache a provider match when its saved policy changed during verification", async () => {
  const sandbox = workspace();
  await sandbox.updateNetwork({
    allowOut: policy.allow,
    denyOut: ["0.0.0.0/0"],
  });
  query
    .mockResolvedValueOnce({ policy, revision: 2, status: "ready" })
    .mockResolvedValueOnce({ policy, revision: 3, status: "applying" });
  mutation
    .mockReset()
    .mockRejectedValueOnce(
      new ConvexError("A network update is already running."),
    );
  await expect(
    ensureCloudNetwork(sandbox as any, "owner", "us"),
  ).rejects.toThrow("already running");
});

it("releases the writer lease after an inventory failure before any provider write", async () => {
  (Sandbox.list as jest.Mock).mockReturnValue({
    nextItems: async () => {
      throw new Error("inventory unavailable");
    },
    hasNext: false,
  });
  await expect(saveNetworkSettings("owner", policy, 1)).rejects.toThrow(
    "could not be verified",
  );
  expect(mutation.mock.calls[1][1]).toMatchObject({
    success: false,
    releaseLease: true,
  });
});
it.each([
  { allow: Array(101).fill("example.test") },
  { allow: ["x".repeat(254)] },
])("gives readable destination size limits", ({ allow }) => {
  expect(() => normalizeNetworkPolicy({ mode: "restricted", allow })).toThrow(
    "at most 100 destinations",
  );
});
it.each(["*.127.0.0.1", "bad host", "999.1.1.1/24"])(
  "keeps destination errors specific to networking: %s",
  (entry) => {
    expect(() =>
      normalizeNetworkPolicy({ mode: "restricted", allow: [entry] }),
    ).toThrow("Use a valid hostname");
  },
);

it("releases a failed reconciliation when canceled before the first provider write", async () => {
  const sandbox = workspace();
  const controller = new AbortController();
  controller.abort();
  query.mockResolvedValueOnce({ policy, revision: 2, status: "failed" });
  sandbox.getInfo.mockRejectedValueOnce(
    new DOMException("Canceled", "AbortError"),
  );
  await expect(
    ensureCloudNetwork(sandbox as any, "owner", "us", controller.signal),
  ).rejects.toThrow("could not be verified");
  expect(sandbox.updateNetwork).not.toHaveBeenCalled();
  expect(mutation.mock.calls[1][1]).toMatchObject({
    success: false,
    releaseLease: true,
  });
});

it("applies and verifies No internet on the same E2B workspace", async () => {
  const offline = { mode: "offline" as const, allow: [] };
  mutation
    .mockReset()
    .mockResolvedValueOnce({ policy: offline, revision: 3, status: "applying" })
    .mockResolvedValue(null);
  const sandbox = workspace();
  (Sandbox.connect as jest.Mock).mockResolvedValue(sandbox);
  expect(await saveNetworkSettings("owner", offline, 2)).toMatchObject({
    policy: offline,
    status: "ready",
  });
  expect(sandbox.updateNetwork).toHaveBeenCalledWith(
    { allowOut: [], denyOut: ["0.0.0.0/0"] },
    expect.anything(),
  );
  expect(mutation.mock.calls[1][1]).toMatchObject({ success: true });
  expect(sandbox.files.get("/home/user/keep.txt")).toBe("unchanged-file");
  expect(Sandbox.create).not.toHaveBeenCalled();
  expect(Sandbox.kill).not.toHaveBeenCalled();
});

describe("acquisition network suboperation reports", () => {
  const ready = { policy, revision: 2, status: "ready" as const };
  const RESOLVED = Symbol("resolved");
  type Scenario = () => {
    sandbox: ReturnType<typeof workspace>;
    signal?: AbortSignal;
    /** Exact rejection identity, or undefined for applyNetwork's rewrap. */
    original?: unknown;
  };
  const verifiedPrefix: CloudNetworkSuboperation[] = [
    "settings_read",
    "ready_cache_check",
    "provider_info_read",
    "policy_compare",
  ];
  const cases: [string, CloudNetworkSuboperation[], Scenario][] = [
    [
      "settings_read",
      ["settings_read"],
      () => {
        const original = new TypeError("PRIVATE_SETTINGS_READ");
        query.mockReset().mockRejectedValueOnce(original);
        return { sandbox: workspace(), original };
      },
    ],
    [
      "provider_info_read",
      verifiedPrefix.slice(0, 3),
      () => {
        const sandbox = workspace();
        const original = Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNRESET" },
        });
        sandbox.getInfo.mockRejectedValueOnce(original);
        return { sandbox, original };
      },
    ],
    [
      "policy_compare",
      verifiedPrefix,
      () => {
        const sandbox = workspace();
        const original = new TypeError("PRIVATE_COMPARE");
        sandbox.getInfo.mockResolvedValueOnce({
          get metadata() {
            throw original;
          },
        });
        return { sandbox, original };
      },
    ],
    [
      "settings_recheck",
      [...verifiedPrefix, "settings_recheck"],
      () => {
        const original = new TypeError("PRIVATE_RECHECK");
        query
          .mockReset()
          .mockResolvedValueOnce(ready)
          .mockRejectedValueOnce(original);
        return { sandbox: workspace("owner", appliedPolicy()), original };
      },
    ],
    [
      "post_check",
      [...verifiedPrefix, "settings_recheck", "post_check"],
      () => {
        const controller = new AbortController();
        const original = Object.freeze({ private: "PRIVATE_LATE_ABORT" });
        query
          .mockReset()
          .mockResolvedValueOnce(ready)
          .mockImplementationOnce(async () => {
            controller.abort(original);
            return ready;
          });
        return {
          sandbox: workspace("owner", appliedPolicy()),
          signal: controller.signal,
          original,
        };
      },
    ],
    [
      // Nested applyNetwork verification keeps the umbrella step: no further
      // provider_info_read/policy_compare reports follow policy_apply.
      "policy_apply",
      [...verifiedPrefix, "policy_apply"],
      () => {
        const sandbox = workspace();
        sandbox.updateNetwork.mockRejectedValueOnce(
          new TypeError("PRIVATE_APPLY"),
        );
        return { sandbox };
      },
    ],
  ];

  it.each(cases)(
    "reports %s without changing the original failure or provider calls",
    async (_step, expected, scenario) => {
      const run = async (reporter?: ReportCloudNetworkSuboperation) => {
        resetMocks();
        const { sandbox, signal, original } = scenario();
        const error = await ensureCloudNetwork(
          sandbox as any,
          "owner",
          "us",
          signal,
          reporter,
        ).then(
          () => RESOLVED,
          (rejection: unknown) => rejection,
        );
        if (original !== undefined) expect(error).toBe(original);
        else {
          // applyNetwork's existing rewrap stays the caller-visible failure.
          expect(error).toBeInstanceOf(NetworkSettingsError);
          expect((error as Error).message).toContain("could not be verified");
        }
        return {
          getInfo: sandbox.getInfo.mock.calls.length,
          updateNetwork: sandbox.updateNetwork.mock.calls.length,
          query: query.mock.calls.length,
          mutation: mutation.mock.calls.map(([, args]) => [
            args?.success,
            args?.releaseLease,
          ]),
        };
      };
      const baseline = await run();
      const reports: unknown[] = [];
      expect(
        await run((step) => {
          reports.push(step);
        }),
      ).toEqual(baseline);
      expect(reports).toEqual(expected);
      expect(
        await run(() => {
          throw new Error("reporter failed");
        }),
      ).toEqual(baseline);
    },
  );

  it("keeps verification and the cached ready path unchanged when the reporter throws", async () => {
    const sandbox = workspace("owner", appliedPolicy());
    const throwing = jest.fn((step: CloudNetworkSuboperation) => {
      throw new Error(`reporter failed at ${step}`);
    });
    await expect(
      ensureCloudNetwork(sandbox as any, "owner", "us", undefined, throwing),
    ).resolves.toBeUndefined();
    expect(throwing.mock.calls.map(([step]) => step)).toEqual([
      ...verifiedPrefix,
      "settings_recheck",
      "post_check",
    ]);
    expect(sandbox.getInfo).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);

    const reports: unknown[] = [];
    await ensureCloudNetwork(
      sandbox as any,
      "owner",
      "us",
      undefined,
      (step) => {
        reports.push(step);
      },
    );
    expect(reports).toEqual(["settings_read", "ready_cache_check"]);
    // The cache hit performs only its settings read: no provider I/O.
    expect(sandbox.getInfo).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(3);
    expect(sandbox.updateNetwork).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });
});

describe("managed egress pilot", () => {
  // Synthetic fixture values only.
  const PROXY = {
    address: "us-egress.example.test:1080",
    username: "qa-egress-us",
    password: "synthetic-us-proxy-secret",
  };
  const EU_PROXY = {
    address: "eu-egress.example.test:1080",
    username: "qa-egress-eu",
    password: "synthetic-eu-proxy-secret",
  };
  const MASKED = { address: PROXY.address, username: PROXY.username };
  const DENY_ALL = ["0.0.0.0/0"];
  type PilotEnv =
    | "E2B_MANAGED_EGRESS_ENABLED"
    | "E2B_MANAGED_EGRESS_USERS"
    | "E2B_MANAGED_EGRESS_US_PROXY"
    | "E2B_MANAGED_EGRESS_EU_PROXY"
    | "E2B_MANAGED_EGRESS_DESTINATIONS";
  const UNAVAILABLE = "Managed network egress is unavailable for this account.";
  function configure(overrides: Partial<Record<PilotEnv, string | undefined>>) {
    const values: Record<PilotEnv, string | undefined> = {
      E2B_MANAGED_EGRESS_ENABLED: undefined,
      E2B_MANAGED_EGRESS_USERS: "qa-other, owner",
      E2B_MANAGED_EGRESS_US_PROXY: JSON.stringify(PROXY),
      E2B_MANAGED_EGRESS_EU_PROXY: JSON.stringify(EU_PROXY),
      E2B_MANAGED_EGRESS_DESTINATIONS:
        "api.example.test,example.test,approved.test",
      ...overrides,
    };
    for (const [name, value] of Object.entries(values))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
  function beginWith(saved: NetworkPolicy) {
    mutation
      .mockReset()
      .mockResolvedValueOnce({ policy: saved, revision: 3, status: "applying" })
      .mockResolvedValue(null);
  }
  /** One running workspace per cluster; EU inventory is listed by its domain. */
  function inventory(
    byCluster: { us?: string[]; eu?: string[] },
    owner = "owner",
  ) {
    (Sandbox.list as jest.Mock).mockImplementation(
      (options: { domain?: string }) => ({
        nextItems: async () =>
          (options.domain === EU_DOMAIN ? byCluster.eu : byCluster.us)?.map(
            (sandboxId) => ({ sandboxId, metadata: { userID: owner } }),
          ) ?? [],
        hasNext: false,
      }),
    );
  }
  function connectable(...sandboxes: ReturnType<typeof workspace>[]) {
    (Sandbox.connect as jest.Mock).mockImplementation(
      async (sandboxId: string, options: { domain?: string }) => {
        const sandbox = sandboxes.find((each) => each.sandboxId === sandboxId);
        // Connecting through the wrong cluster finds nothing.
        const cluster = options.domain === EU_DOMAIN ? "eu" : "us";
        if (!sandbox || !sandboxId.startsWith(cluster))
          throw new Error("not found");
        return sandbox;
      },
    );
  }

  it.each([undefined, "", "false"])(
    "keeps non-enrolled accounts on the exact direct policy in both regions without reading pilot config (global toggle %p)",
    async (enabled) => {
      enableEuCluster();
      configure({
        E2B_MANAGED_EGRESS_ENABLED: enabled,
        E2B_MANAGED_EGRESS_DESTINATIONS: "*",
        E2B_MANAGED_EGRESS_USERS: "owner-other",
        E2B_MANAGED_EGRESS_US_PROXY: "not json",
        E2B_MANAGED_EGRESS_EU_PROXY: undefined,
      });
      const us = workspace("owner", undefined, "us-workspace");
      const eu = workspace("owner", undefined, "eu-workspace");
      inventory({ us: [us.sandboxId], eu: [eu.sandboxId] });
      connectable(us, eu);
      await saveNetworkSettings("owner", policy, 1);
      for (const sandbox of [us, eu])
        expect(sandbox.updateNetwork.mock.calls).toEqual([
          [
            { allowOut: ["api.example.test"], denyOut: DENY_ALL },
            expect.anything(),
          ],
        ]);
      expect(mutation.mock.calls[1][1]).toMatchObject({ success: true });
    },
  );

  it("applies Settings to a US and an EU workspace through each region's own proxy", async () => {
    enableEuCluster();
    configure({});
    const us = workspace("owner", undefined, "us-workspace");
    const eu = workspace("owner", undefined, "eu-workspace");
    inventory({ us: [us.sandboxId], eu: [eu.sandboxId] });
    connectable(us, eu);
    await saveNetworkSettings("owner", policy, 1);
    expect(us.updateNetwork.mock.calls[0][0]).toStrictEqual({
      allowOut: ["api.example.test"],
      denyOut: DENY_ALL,
      egressProxy: PROXY,
    });
    expect(eu.updateNetwork.mock.calls[0][0]).toStrictEqual({
      allowOut: ["api.example.test"],
      denyOut: DENY_ALL,
      egressProxy: EU_PROXY,
    });
    expect(mutation.mock.calls[1][1]).toMatchObject({ success: true });
  });

  it("reconciles an acquired EU workspace with the EU proxy and a listed US workspace with the US proxy", async () => {
    enableEuCluster();
    configure({});
    const eu = workspace("owner", undefined, "eu-acquired");
    const us = workspace("owner", undefined, "us-listed");
    // The acquired workspace also appears in its own cluster's inventory.
    inventory({ us: [us.sandboxId], eu: [eu.sandboxId] });
    connectable(us, eu);
    await ensureCloudNetwork(eu as any, "owner", "eu");
    expect(eu.updateNetwork.mock.calls).toEqual([
      [
        {
          allowOut: ["api.example.test"],
          denyOut: DENY_ALL,
          egressProxy: EU_PROXY,
        },
        expect.anything(),
      ],
    ]);
    expect(us.updateNetwork.mock.calls).toEqual([
      [
        {
          allowOut: ["api.example.test"],
          denyOut: DENY_ALL,
          egressProxy: PROXY,
        },
        expect.anything(),
      ],
    ]);
    expect(Sandbox.connect).toHaveBeenCalledTimes(1);
    expect(mutation.mock.calls[1][1]).toMatchObject({ success: true });
  });

  it.each<[string, NetworkPolicy, string[]]>([
    [
      "Internet access",
      { mode: "unrestricted", allow: [] },
      ["api.example.test", "approved.test", "example.test"],
    ],
    [
      "a wildcard and IP grant",
      {
        mode: "restricted",
        allow: ["*.example.test", "203.0.113.7", "203.0.113.0/24"],
      },
      // The wildcard covers subdomains only; IP/CIDR grants never widen access.
      ["api.example.test"],
    ],
    [
      "unrelated destinations",
      { mode: "restricted", allow: ["unlisted.test"] },
      [],
    ],
    ["No internet", { mode: "offline", allow: [] }, []],
  ])(
    "applies %s as deny-all plus approved destinations through the managed proxy",
    async (_label, saved, allowOut) => {
      configure({});
      beginWith(saved);
      const sandbox = workspace();
      (Sandbox.connect as jest.Mock).mockResolvedValue(sandbox);
      const result = await saveNetworkSettings("owner", saved, 2);
      expect(sandbox.updateNetwork.mock.calls[0][0]).toStrictEqual({
        allowOut,
        denyOut: DENY_ALL,
        egressProxy: PROXY,
      });
      expect(mutation.mock.calls[1][1]).toMatchObject({ success: true });
      // Server-only proxy configuration never joins the saved user settings.
      expect(result).toEqual({ policy: saved, revision: 3, status: "ready" });
    },
  );

  it("verifies an already proxied workspace on every acquisition without rewriting it", async () => {
    configure({});
    const sandbox = workspace("owner", {
      allowOut: ["api.example.test"],
      denyOut: DENY_ALL,
      egressProxy: MASKED,
    });
    await ensureCloudNetwork(sandbox as any, "owner", "us");
    await ensureCloudNetwork(sandbox as any, "owner", "us");
    expect(sandbox.getInfo).toHaveBeenCalledTimes(2);
    expect(sandbox.updateNetwork).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });

  it("adds the missing managed proxy through the existing writer", async () => {
    configure({});
    const sandbox = workspace("owner", {
      allowOut: ["api.example.test"],
      denyOut: DENY_ALL,
    });
    await ensureCloudNetwork(sandbox as any, "owner", "us");
    expect(sandbox.updateNetwork).toHaveBeenCalledWith(
      { allowOut: ["api.example.test"], denyOut: DENY_ALL, egressProxy: PROXY },
      expect.anything(),
    );
    expect(mutation.mock.calls[1][1]).toMatchObject({ success: true });
  });

  it("fails acquisition when the provider readback omits the proxy after a write", async () => {
    configure({});
    const sandbox = workspace();
    let stored: ProviderNetwork = { allowOut: [], denyOut: [] };
    sandbox.getInfo.mockImplementation(async () => ({
      metadata: { userID: "owner" },
      network: stored,
    }));
    sandbox.updateNetwork.mockImplementation(async ({ allowOut, denyOut }) => {
      stored = { allowOut, denyOut };
    });
    await expect(
      ensureCloudNetwork(sandbox as any, "owner", "us"),
    ).rejects.toThrow("could not be verified");
    expect(mutation.mock.calls[1][1]).toMatchObject({
      success: false,
      releaseLease: false,
    });
  });

  it.each<[string, string, ProviderNetwork]>([
    [
      "a foreign proxy address",
      "owner",
      {
        allowOut: ["api.example.test"],
        denyOut: DENY_ALL,
        egressProxy: { ...MASKED, address: "other-proxy.example.test:1080" },
      },
    ],
    [
      "a foreign proxy username",
      "owner",
      {
        allowOut: ["api.example.test"],
        denyOut: DENY_ALL,
        egressProxy: { ...MASKED, username: "someone-else" },
      },
    ],
    [
      "a credential transform",
      "owner",
      {
        allowOut: ["api.example.test"],
        denyOut: DENY_ALL,
        egressProxy: MASKED,
        rules: { "api.example.test": [{ transform: {} }] },
      },
    ],
    [
      "a proxy on a non-enrolled account",
      "qa-other",
      {
        allowOut: ["api.example.test"],
        denyOut: DENY_ALL,
        egressProxy: MASKED,
      },
    ],
    [
      // No cross-region fallback: a US workspace never accepts the EU proxy.
      "the other region's proxy",
      "owner",
      {
        allowOut: ["api.example.test"],
        denyOut: DENY_ALL,
        egressProxy: { address: EU_PROXY.address, username: EU_PROXY.username },
      },
    ],
  ])(
    "rejects %s instead of overwriting or clearing it",
    async (_label, enrolled, network) => {
      configure({ E2B_MANAGED_EGRESS_USERS: enrolled });
      const sandbox = workspace("owner", network);
      await expect(
        ensureCloudNetwork(sandbox as any, "owner", "us"),
      ).rejects.toThrow("Externally managed network configuration");
      expect(sandbox.updateNetwork).not.toHaveBeenCalled();
    },
  );

  it.each<[string, Parameters<typeof configure>[0]]>([
    ["missing US proxy", { E2B_MANAGED_EGRESS_US_PROXY: undefined }],
    ["missing EU proxy", { E2B_MANAGED_EGRESS_EU_PROXY: undefined }],
    ["unparseable proxy", { E2B_MANAGED_EGRESS_US_PROXY: "{" }],
    [
      "proxy without a port",
      {
        E2B_MANAGED_EGRESS_US_PROXY: JSON.stringify({
          ...PROXY,
          address: "us-egress.example.test",
        }),
      },
    ],
    [
      "proxy URL",
      {
        E2B_MANAGED_EGRESS_EU_PROXY: JSON.stringify({
          ...EU_PROXY,
          address: `socks5://${EU_PROXY.address}`,
        }),
      },
    ],
    [
      "proxy without credentials",
      {
        E2B_MANAGED_EGRESS_EU_PROXY: JSON.stringify({
          address: EU_PROXY.address,
          username: EU_PROXY.username,
        }),
      },
    ],
    [
      "password over 255 UTF-8 bytes",
      {
        E2B_MANAGED_EGRESS_US_PROXY: JSON.stringify({
          ...PROXY,
          password: "é".repeat(128),
        }),
      },
    ],
    [
      "unknown proxy field",
      {
        E2B_MANAGED_EGRESS_US_PROXY: JSON.stringify({
          ...PROXY,
          dns: "1.1.1.1",
        }),
      },
    ],
    [
      "both regions on one host",
      {
        E2B_MANAGED_EGRESS_EU_PROXY: JSON.stringify({
          ...EU_PROXY,
          address: "us-egress.example.test:1081",
        }),
      },
    ],
    [
      "both regions on one IP",
      {
        E2B_MANAGED_EGRESS_US_PROXY: JSON.stringify({
          ...PROXY,
          address: "192.0.2.10:1080",
        }),
        E2B_MANAGED_EGRESS_EU_PROXY: JSON.stringify({
          ...EU_PROXY,
          address: "192.0.2.10:1080",
        }),
      },
    ],
    ["missing destinations", { E2B_MANAGED_EGRESS_DESTINATIONS: undefined }],
    ["wildcard", { E2B_MANAGED_EGRESS_DESTINATIONS: "*.example.test" }],
    ["IP destination", { E2B_MANAGED_EGRESS_DESTINATIONS: "203.0.113.7" }],
    [
      "alternate IP spelling",
      { E2B_MANAGED_EGRESS_DESTINATIONS: "0x7f.0x0.0x0.0x1" },
    ],
    ["URL", { E2B_MANAGED_EGRESS_DESTINATIONS: "https://api.example.test/x" }],
    ["port", { E2B_MANAGED_EGRESS_DESTINATIONS: "api.example.test:443" }],
    ["single label", { E2B_MANAGED_EGRESS_DESTINATIONS: "intranet" }],
    ["uppercase", { E2B_MANAGED_EGRESS_DESTINATIONS: "API.example.test" }],
    ["empty entry", { E2B_MANAGED_EGRESS_DESTINATIONS: "api.example.test,," }],
    // "*" is general egress only as the sole entry.
    [
      "general wildcard mixed with a hostname",
      { E2B_MANAGED_EGRESS_DESTINATIONS: "*,api.example.test" },
    ],
    ["repeated general wildcard", { E2B_MANAGED_EGRESS_DESTINATIONS: "*,*" }],
    ["bare wildcard label", { E2B_MANAGED_EGRESS_DESTINATIONS: "*.*" }],
    [
      "missing proxy under global enrollment",
      {
        E2B_MANAGED_EGRESS_ENABLED: "true",
        E2B_MANAGED_EGRESS_USERS: undefined,
        E2B_MANAGED_EGRESS_DESTINATIONS: "*",
        E2B_MANAGED_EGRESS_EU_PROXY: undefined,
      },
    ],
  ])(
    "fails closed with a generic error before the writer lease on %s",
    async (_label, overrides) => {
      enableEuCluster();
      configure(overrides);
      const save = saveNetworkSettings("owner", policy, 1);
      await expect(save).rejects.toMatchObject({
        status: 503,
        message: UNAVAILABLE,
      });
      // Either region's acquisition needs both regional proxies to be valid.
      for (const cluster of ["us", "eu"] as const) {
        const sandbox = workspace();
        await expect(
          ensureCloudNetwork(sandbox as any, "owner", cluster),
        ).rejects.toMatchObject({ message: UNAVAILABLE });
        expect(sandbox.getInfo).not.toHaveBeenCalled();
      }
      expect(mutation).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(Sandbox.list).not.toHaveBeenCalled();
    },
  );

  function createInEmptyInventory(
    region: "us-east-1" | "us-west-2" | "eu-central-1",
  ) {
    (Sandbox.list as jest.Mock).mockReturnValue({
      nextItems: async () => [],
      hasNext: false,
    });
    (Sandbox.create as jest.Mock).mockImplementation(async (_template, opts) =>
      workspace("owner", opts.network),
    );
    return ensureSandboxConnection(
      { userID: "owner", setSandbox: jest.fn() },
      {
        triggerRegion: region,
        reservation: {
          version: 1,
          phase: "provisioning",
          step: "reserved",
          token: "reservation",
          region,
        },
      },
    );
  }

  it.each([
    ["us-east-1", "us", "owner", PROXY],
    ["us-west-2", "us", "owner", PROXY],
    ["eu-central-1", "eu", "owner", EU_PROXY],
    ["eu-central-1", "eu", "owner-other", undefined],
    ["us-west-2", "us", "global", PROXY],
    ["eu-central-1", "eu", "global", EU_PROXY],
  ] as const)(
    "creates a %s workspace in the %s cluster for %s enrollment with the policy acquisition verifies",
    async (region, cluster, enrolled, proxy) => {
      enableEuCluster();
      configure(
        enrolled === "global"
          ? {
              E2B_MANAGED_EGRESS_ENABLED: "true",
              E2B_MANAGED_EGRESS_USERS: undefined,
              E2B_MANAGED_EGRESS_DESTINATIONS: "*",
            }
          : { E2B_MANAGED_EGRESS_USERS: enrolled },
      );
      const { sandbox } = await createInEmptyInventory(region);
      const [, created] = (Sandbox.create as jest.Mock).mock.calls[0];
      expect(created.metadata.e2bCluster).toBe(cluster);
      expect(created.domain).toBe(cluster === "eu" ? EU_DOMAIN : undefined);
      expect(created.network).toStrictEqual({
        allowOut: ["api.example.test"],
        denyOut: DENY_ALL,
        ...(proxy && { egressProxy: proxy }),
      });
      query.mockClear();
      await ensureCloudNetwork(sandbox, "owner", cluster);
      expect(query).toHaveBeenCalled();
      expect((sandbox as any).updateNetwork).not.toHaveBeenCalled();
      expect(mutation).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["destinations", { E2B_MANAGED_EGRESS_DESTINATIONS: "203.0.113.7" }],
    // A US create still needs the EU proxy to be valid.
    ["EU proxy", { E2B_MANAGED_EGRESS_EU_PROXY: undefined }],
    [
      "global toggle",
      {
        E2B_MANAGED_EGRESS_ENABLED: "yes",
        E2B_MANAGED_EGRESS_USERS: undefined,
      },
    ],
  ])(
    "does not reserve or create a workspace when enrolled %s config is invalid",
    async (_label, overrides) => {
      configure(overrides);
      const log = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(createInEmptyInventory("us-east-1")).rejects.toThrow(
          "Cloud sandbox is temporarily unavailable",
        );
        expect(startWorkspaceCreation).not.toHaveBeenCalled();
        expect(Sandbox.list).not.toHaveBeenCalled();
        expect(Sandbox.create).not.toHaveBeenCalled();
        expect(JSON.stringify(log.mock.calls)).not.toContain(PROXY.password);
      } finally {
        log.mockRestore();
      }
    },
  );

  describe("general egress for every account", () => {
    // "owner" is in no pilot list: the global toggle alone enrolls it.
    const GENERAL = {
      E2B_MANAGED_EGRESS_ENABLED: "true",
      E2B_MANAGED_EGRESS_USERS: undefined,
      E2B_MANAGED_EGRESS_DESTINATIONS: "*",
    };

    it.each<[string, NetworkPolicy, ProviderNetwork]>([
      [
        "Internet access",
        { mode: "unrestricted", allow: [] },
        { allowOut: [], denyOut: [] },
      ],
      [
        "allowed hostnames, wildcards, IPs and CIDRs",
        {
          mode: "restricted",
          allow: [
            "*.example.test",
            "198.51.100.0/24",
            "203.0.113.7",
            "unlisted.test",
          ],
        },
        {
          allowOut: [
            "*.example.test",
            "198.51.100.0/24",
            "203.0.113.7",
            "unlisted.test",
          ],
          denyOut: DENY_ALL,
        },
      ],
      [
        "No internet",
        { mode: "offline", allow: [] },
        { allowOut: [], denyOut: DENY_ALL },
      ],
    ])(
      "applies saved %s unchanged through each region's own proxy",
      async (_label, saved, direct) => {
        enableEuCluster();
        configure(GENERAL);
        beginWith(saved);
        const us = workspace("owner", undefined, "us-workspace");
        const eu = workspace("owner", undefined, "eu-workspace");
        inventory({ us: [us.sandboxId], eu: [eu.sandboxId] });
        connectable(us, eu);
        expect(await saveNetworkSettings("owner", saved, 2)).toEqual({
          policy: saved,
          revision: 3,
          status: "ready",
        });
        expect(us.updateNetwork.mock.calls[0][0]).toStrictEqual({
          ...direct,
          egressProxy: PROXY,
        });
        expect(eu.updateNetwork.mock.calls[0][0]).toStrictEqual({
          ...direct,
          egressProxy: EU_PROXY,
        });
        expect(mutation.mock.calls[1][1]).toMatchObject({ success: true });
      },
    );

    it.each(["TRUE", "1", "yes", " true"])(
      "fails closed for every account on the invalid global toggle %p",
      async (value) => {
        configure({ ...GENERAL, E2B_MANAGED_EGRESS_ENABLED: value });
        await expect(
          saveNetworkSettings("owner", policy, 1),
        ).rejects.toMatchObject({ status: 503, message: UNAVAILABLE });
        const sandbox = workspace();
        await expect(
          ensureCloudNetwork(sandbox as any, "owner", "us"),
        ).rejects.toMatchObject({ message: UNAVAILABLE });
        expect(sandbox.getInfo).not.toHaveBeenCalled();
        expect(mutation).not.toHaveBeenCalled();
        expect(Sandbox.list).not.toHaveBeenCalled();
      },
    );

    it("migrates an existing direct workspace in place on acquisition and keeps the proxy when the policy later changes", async () => {
      enableEuCluster();
      configure(GENERAL);
      // A workspace created before enrollment, with the unsaved default.
      const sandbox = workspace(
        "owner",
        { allowOut: [], denyOut: [] },
        "eu-workspace",
      );
      inventory({ eu: [sandbox.sandboxId] });
      connectable(sandbox);
      const internet: NetworkPolicy = { mode: "unrestricted", allow: [] };
      query.mockResolvedValue(null);
      beginWith(internet);
      await ensureCloudNetwork(sandbox as any, "owner", "eu");
      expect(mutation).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({ policy: internet, expectedRevision: 0 }),
      );
      expect(sandbox.updateNetwork.mock.calls).toEqual([
        [
          { allowOut: [], denyOut: [], egressProxy: EU_PROXY },
          expect.anything(),
        ],
      ]);

      // A later restriction is reconciled on acquisition without dropping
      // the proxy that E2B's full-replacement update would otherwise clear.
      const restricted: NetworkPolicy = {
        mode: "restricted",
        allow: ["198.51.100.0/24"],
      };
      query.mockResolvedValue({
        policy: restricted,
        revision: 4,
        status: "ready",
      });
      beginWith(restricted);
      sandbox.updateNetwork.mockClear();
      await ensureCloudNetwork(sandbox as any, "owner", "eu");
      expect(sandbox.updateNetwork.mock.calls).toEqual([
        [
          {
            allowOut: ["198.51.100.0/24"],
            denyOut: DENY_ALL,
            egressProxy: EU_PROXY,
          },
          expect.anything(),
        ],
      ]);
      expect(mutation.mock.calls[1][1]).toMatchObject({ success: true });
      expect(sandbox.files.get("/home/user/keep.txt")).toBe("unchanged-file");
      expect(Sandbox.create).not.toHaveBeenCalled();
      expect(Sandbox.kill).not.toHaveBeenCalled();
    });
  });

  describe("per-workspace attribution", () => {
    // Shared vectors, also checked by the PAM module and Python fixture.
    const [first, second, europe] = fixture.vectors;
    const OWNER = first.userId;
    const KEYS = {
      E2B_EGRESS_ATTRIBUTION_US_KEY: fixture.attributionKeys.us,
      E2B_EGRESS_ATTRIBUTION_EU_KEY: fixture.attributionKeys.eu,
    };
    const APPLIED = { allowOut: ["api.example.test"], denyOut: DENY_ALL };
    const shared = { us: PROXY, eu: EU_PROXY };
    const attributed = (vector: typeof first) => ({
      address: shared[vector.region as "us" | "eu"].address,
      username: vector.username,
      password: vector.password,
    });
    const masked = ({
      address,
      username,
    }: {
      address: string;
      username: string;
    }) => ({
      address,
      username,
    });
    let store: Map<string, string>;
    function registry() {
      store = new Map();
      const read = (key: string) => {
        const value = store.get(key);
        return value === undefined ? null : JSON.parse(value);
      };
      jest.mocked(createRedisClient).mockReturnValue({
        set: jest.fn(
          async (key: string, value: string, opts?: { nx?: boolean }) => {
            if (opts?.nx && store.has(key)) return null;
            store.set(key, value);
            return "OK";
          },
        ),
        get: jest.fn(async (key: string) => read(key)),
        expire: jest.fn(async () => 1),
      } as never);
    }
    function enroll(overrides: Record<string, string | undefined> = {}) {
      enableEuCluster();
      configure({ E2B_MANAGED_EGRESS_USERS: OWNER });
      Object.assign(process.env, KEYS, {
        E2B_EGRESS_ATTRIBUTION_USERS: OWNER,
      });
      for (const [name, value] of Object.entries(overrides))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    beforeEach(registry);

    it.each([first, europe])(
      "moves a $region workspace from the shared identity to its attributed identity after confirming ownership",
      async (vector) => {
        enroll();
        const region = vector.region as "us" | "eu";
        const sandbox = workspace(
          OWNER,
          { ...APPLIED, egressProxy: masked(shared[region]) },
          vector.sandboxId,
        );
        inventory({ [region]: [sandbox.sandboxId] }, OWNER);
        await ensureCloudNetwork(sandbox as any, OWNER, region);
        // Same regional address; only the credential changes.
        expect(sandbox.updateNetwork.mock.calls).toEqual([
          [{ ...APPLIED, egressProxy: attributed(vector) }, expect.anything()],
        ]);
        expect(mutation.mock.calls[1][1]).toMatchObject({ success: true });
        expect(
          JSON.parse(
            store.get(
              `egress-attribution:v1:${region}:workspace:${vector.workspace}`,
            )!,
          ),
        ).toEqual({
          userId: OWNER,
          sandboxId: vector.sandboxId,
          owner: vector.owner,
        });
        expect(sandbox.files.get("/home/user/keep.txt")).toBe("unchanged-file");
        expect(Sandbox.create).not.toHaveBeenCalled();
        expect(Sandbox.kill).not.toHaveBeenCalled();

        // The next acquisition verifies the pinned identity without a write.
        sandbox.updateNetwork.mockClear();
        mutation.mockClear();
        await ensureCloudNetwork(sandbox as any, OWNER, region);
        expect(sandbox.updateNetwork).not.toHaveBeenCalled();
        expect(mutation).not.toHaveBeenCalled();
      },
    );

    it("does not attribute before ownership is confirmed by the provider", async () => {
      enroll();
      const sandbox = workspace(
        "someone-else",
        { ...APPLIED, egressProxy: masked(PROXY) },
        first.sandboxId,
      );
      await expect(
        ensureCloudNetwork(sandbox as any, OWNER, "us"),
      ).rejects.toThrow("Workspace ownership mismatch");
      expect(sandbox.updateNetwork).not.toHaveBeenCalled();
      expect(store.size).toBe(0);
    });

    it("keeps an attributed workspace pinned, and rewrites its credential, after new enrollment is withdrawn", async () => {
      enroll({ E2B_EGRESS_ATTRIBUTION_USERS: undefined });
      const sandbox = workspace(
        OWNER,
        { ...APPLIED, egressProxy: masked(attributed(first)) },
        first.sandboxId,
      );
      inventory({ us: [sandbox.sandboxId] }, OWNER);
      connectable(sandbox);
      // Not enrolled, a shared-identity workspace stays shared.
      const legacy = workspace(
        OWNER,
        { ...APPLIED, egressProxy: masked(PROXY) },
        second.sandboxId,
      );
      await ensureCloudNetwork(legacy as any, OWNER, "us");
      expect(legacy.updateNetwork).not.toHaveBeenCalled();

      const offline: NetworkPolicy = { mode: "offline", allow: [] };
      beginWith(offline);
      (Sandbox.connect as jest.Mock).mockResolvedValue(sandbox);
      await saveNetworkSettings(OWNER, offline, 2);
      // E2B's full replacement needs the attributed password, not the shared one.
      expect(sandbox.updateNetwork.mock.calls).toEqual([
        [
          { allowOut: [], denyOut: DENY_ALL, egressProxy: attributed(first) },
          expect.anything(),
        ],
      ]);
      expect(mutation.mock.calls[1][1]).toMatchObject({ success: true });
    });

    it.each<[string, Record<string, string | undefined>]>([
      [
        "keys are removed",
        {
          E2B_EGRESS_ATTRIBUTION_USERS: undefined,
          E2B_EGRESS_ATTRIBUTION_US_KEY: undefined,
          E2B_EGRESS_ATTRIBUTION_EU_KEY: undefined,
        },
      ],
      // A rotated key cannot recognize identities signed with the old one.
      [
        "the regional key changes",
        { E2B_EGRESS_ATTRIBUTION_US_KEY: "2a".repeat(32) },
      ],
    ])(
      "fails an attributed workspace closed, without clearing it, when %s",
      async (_label, overrides) => {
        enroll(overrides);
        const sandbox = workspace(
          OWNER,
          { ...APPLIED, egressProxy: masked(attributed(first)) },
          first.sandboxId,
        );
        await expect(
          ensureCloudNetwork(sandbox as any, OWNER, "us"),
        ).rejects.toThrow("Externally managed network configuration");
        expect(sandbox.updateNetwork).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["another workspace's attributed identity", masked(attributed(second))],
      [
        "the other region's attributed identity",
        { address: PROXY.address, username: europe.username },
      ],
      [
        "an attributed name on a different address",
        { address: EU_PROXY.address, username: first.username },
      ],
      [
        "a foreign credential on the shared address",
        { address: PROXY.address, username: "other" },
      ],
    ])("rejects %s instead of replacing it", async (_label, egressProxy) => {
      enroll();
      const sandbox = workspace(
        OWNER,
        { ...APPLIED, egressProxy },
        first.sandboxId,
      );
      await expect(
        ensureCloudNetwork(sandbox as any, OWNER, "us"),
      ).rejects.toThrow("Externally managed network configuration");
      expect(sandbox.updateNetwork).not.toHaveBeenCalled();
      expect(store.size).toBe(0);
    });

    it("keeps the shared identity while the registry is unavailable and migrates once it returns", async () => {
      enroll();
      jest.mocked(createRedisClient).mockReturnValue(null);
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const sandbox = workspace(
          OWNER,
          { ...APPLIED, egressProxy: masked(PROXY) },
          first.sandboxId,
        );
        inventory({ us: [sandbox.sandboxId] }, OWNER);
        await ensureCloudNetwork(sandbox as any, OWNER, "us");
        expect(sandbox.updateNetwork).not.toHaveBeenCalled();
        expect(mutation).not.toHaveBeenCalled();
        expect(warn.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
          {
            event: "egress_attribution_registry_unavailable",
            region: "us",
            outcome: "kept_shared",
          },
        ]);

        registry();
        await ensureCloudNetwork(sandbox as any, OWNER, "us");
        expect(sandbox.updateNetwork.mock.calls).toEqual([
          [{ ...APPLIED, egressProxy: attributed(first) }, expect.anything()],
        ]);
      } finally {
        warn.mockRestore();
      }
    });

    it("fails closed on a registry conflict without writing the workspace", async () => {
      enroll();
      store.set(
        `egress-attribution:v1:us:owner:${first.owner}`,
        JSON.stringify({ userId: "user_other" }),
      );
      const sandbox = workspace(
        OWNER,
        { ...APPLIED, egressProxy: masked(PROXY) },
        first.sandboxId,
      );
      await expect(
        ensureCloudNetwork(sandbox as any, OWNER, "us"),
      ).rejects.toThrow("Egress attribution identity conflict");
      expect(sandbox.updateNetwork).not.toHaveBeenCalled();
    });

    it("creates with the shared identity, which the first acquisition then attributes, and keeps the health probe shared", async () => {
      // The monitor requires, and these toggles give, global enrollment.
      enroll({
        E2B_MANAGED_EGRESS_ENABLED: "true",
        E2B_EGRESS_ATTRIBUTION_USERS: undefined,
        E2B_EGRESS_ATTRIBUTION_ENABLED: "true",
      });
      // The sandbox ID is unknown until create returns.
      const { sandbox } = await createInEmptyInventory("us-east-1");
      expect(
        (Sandbox.create as jest.Mock).mock.calls[0][1].network,
      ).toStrictEqual({
        ...APPLIED,
        egressProxy: PROXY,
      });
      await ensureCloudNetwork(sandbox, "owner", "us");
      const [[written]] = (sandbox as any).updateNetwork.mock.calls;
      expect(written.egressProxy).toEqual({
        address: PROXY.address,
        username: expect.stringMatching(/^hae-v1-[0-9a-f]{32}-[0-9a-f]{32}$/),
        password: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      // Global attribution never changes the monitor's shared credential.
      for (const region of ["us", "eu"] as const)
        expect(
          managedEgressForCluster(
            resolveManagedEgress("egress-health-monitor"),
            region,
          )?.proxy,
        ).toEqual(shared[region]);
    });

    it.each<[string, Record<string, string | undefined>]>([
      ["an invalid toggle", { E2B_EGRESS_ATTRIBUTION_ENABLED: "yes" }],
      [
        "enrollment without keys",
        {
          ...KEYS,
          E2B_EGRESS_ATTRIBUTION_US_KEY: undefined,
          E2B_EGRESS_ATTRIBUTION_EU_KEY: undefined,
        },
      ],
      ["a single regional key", { E2B_EGRESS_ATTRIBUTION_EU_KEY: undefined }],
      [
        "one key for both regions",
        { E2B_EGRESS_ATTRIBUTION_EU_KEY: fixture.attributionKeys.us },
      ],
      [
        "an attribution key reused for telemetry",
        { E2B_EGRESS_TELEMETRY_US_KEY: fixture.attributionKeys.eu },
      ],
      [
        "a shared username in the reserved namespace",
        {
          E2B_MANAGED_EGRESS_US_PROXY: JSON.stringify({
            ...PROXY,
            username: "hae-shared",
          }),
        },
      ],
    ])(
      "fails closed with a generic error before the writer lease on %s",
      async (_label, overrides) => {
        enroll(overrides);
        await expect(
          saveNetworkSettings(OWNER, policy, 1),
        ).rejects.toMatchObject({ status: 503, message: UNAVAILABLE });
        const sandbox = workspace(OWNER, undefined, first.sandboxId);
        await expect(
          ensureCloudNetwork(sandbox as any, OWNER, "us"),
        ).rejects.toMatchObject({ message: UNAVAILABLE });
        expect(sandbox.getInfo).not.toHaveBeenCalled();
        expect(mutation).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
        expect(Sandbox.list).not.toHaveBeenCalled();
      },
    );
  });
});
