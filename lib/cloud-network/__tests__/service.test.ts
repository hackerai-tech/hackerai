import { Sandbox } from "@e2b/code-interpreter";
import { getConvexClient } from "@/lib/db/convex-client";
import {
  ensureCloudNetwork,
  NetworkSettingsError,
  saveNetworkSettings,
  type CloudNetworkSuboperation,
  type ReportCloudNetworkSuboperation,
} from "../service";
import { normalizeNetworkPolicy } from "../policy";
import { ConvexError } from "convex/values";

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    list: jest.fn(),
    connect: jest.fn(),
    create: jest.fn(),
    kill: jest.fn(),
  },
}));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("@/lib/ai/tools/utils/e2b-cluster", () => ({
  getConfiguredE2BClustersForCleanup: () => [{ cluster: "us" }],
}));
jest.mock("@/lib/ai/tools/utils/cloud-workspace-guard", () => ({
  assertCloudWorkspaceAvailable: jest.fn(),
  readCloudWorkspaceState: jest.fn(async () => null),
}));
const policy = { mode: "restricted" as const, allow: ["api.example.test"] };
const mutation = jest.fn();
const query = jest.fn();
function workspace(
  owner = "owner",
  initial = { allowOut: [] as string[], denyOut: [] as string[] },
) {
  let network = initial;
  const files = new Map([["/home/user/keep.txt", "unchanged-file"]]);
  return {
    sandboxId: "existing",
    files,
    getInfo: jest.fn(async (): Promise<unknown> => ({
      metadata: { userID: owner },
      network,
    })),
    updateNetwork: jest.fn(async (value) => {
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
  await ensureCloudNetwork(sandbox as any, "owner");
  expect(sandbox.updateNetwork).toHaveBeenCalled();
  expect(Sandbox.connect).not.toHaveBeenCalled();
  sandbox.updateNetwork.mockClear();
  await ensureCloudNetwork(sandbox as any, "owner");
  expect(sandbox.updateNetwork).not.toHaveBeenCalled();
});
it("keeps default workspaces unchanged and fails closed on storage failure", async () => {
  const sandbox = workspace();
  query.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  await ensureCloudNetwork(sandbox as any, "owner");
  expect(sandbox.updateNetwork).not.toHaveBeenCalled();
  query.mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(ensureCloudNetwork(sandbox as any, "owner")).rejects.toThrow();
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

  await ensureCloudNetwork(sandbox as any, "owner");

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
    ensureCloudNetwork(sandbox as any, "owner"),
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
    ensureCloudNetwork(a as any, "owner"),
    ensureCloudNetwork(b as any, "owner"),
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
  await expect(ensureCloudNetwork(sandbox as any, "owner")).rejects.toThrow(
    "already running",
  );
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
    ensureCloudNetwork(sandbox as any, "owner", controller.signal),
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
      ensureCloudNetwork(sandbox as any, "owner", undefined, throwing),
    ).resolves.toBeUndefined();
    expect(throwing.mock.calls.map(([step]) => step)).toEqual([
      ...verifiedPrefix,
      "settings_recheck",
      "post_check",
    ]);
    expect(sandbox.getInfo).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);

    const reports: unknown[] = [];
    await ensureCloudNetwork(sandbox as any, "owner", undefined, (step) => {
      reports.push(step);
    });
    expect(reports).toEqual(["settings_read", "ready_cache_check"]);
    // The cache hit performs only its settings read: no provider I/O.
    expect(sandbox.getInfo).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(3);
    expect(sandbox.updateNetwork).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });
});
