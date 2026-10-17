jest.mock("node:timers/promises", () => ({
  setTimeout: jest.fn(async () => {}),
}));
const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});
jest.mock("../proxy-vault", () => ({
  readProxySecret: jest.fn(),
  writeProxySecret: jest.fn(),
  deleteProxySecret: jest.fn(),
}));
import {
  readProxySecret,
  writeProxySecret,
  deleteProxySecret,
} from "../proxy-vault";
import { networkForCreation, deleteCloudProxyForAccount } from "../service";
import { Sandbox } from "@e2b/code-interpreter";
import { getConvexClient } from "@/lib/db/convex-client";
import { ensureCloudNetwork, saveNetworkSettings } from "../service";
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
function workspace(owner = "owner") {
  let network = { allowOut: [] as string[], denyOut: [] as string[] };
  const files = new Map([["/home/user/keep.txt", "unchanged-file"]]);
  return {
    sandboxId: "existing",
    files,
    getInfo: jest.fn(async () => ({ metadata: { userID: owner }, network })),
    updateNetwork: jest.fn(async (value) => {
      network = value;
    }),
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(readProxySecret).mockReset();
  jest.mocked(writeProxySecret).mockReset();
  jest.mocked(deleteProxySecret).mockReset();
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
});
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
  query.mockResolvedValueOnce(null);
  await ensureCloudNetwork(sandbox as any, "owner");
  expect(sandbox.updateNetwork).not.toHaveBeenCalled();
  query.mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(ensureCloudNetwork(sandbox as any, "owner")).rejects.toThrow();
});
it.each([
  "https://example.test/api",
  "example.test:8443",
  "127.1",
  "0x7f000001",
  "*.127.0.0.1",
  "192.0.2.0/33",
  "[::1]",
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

it("does not acquire a writer or contact E2B when acquisition is already canceled", async () => {
  const sandbox = workspace();
  const controller = new AbortController();
  controller.abort();
  query.mockResolvedValueOnce({ policy, revision: 2, status: "failed" });
  await expect(
    ensureCloudNetwork(sandbox as any, "owner", controller.signal),
  ).rejects.toThrow();
  expect(mutation).not.toHaveBeenCalled();
  expect(sandbox.getInfo).not.toHaveBeenCalled();
  expect(sandbox.updateNetwork).not.toHaveBeenCalled();
});

const proxySettings = {
  address: "proxy.example.test:1080",
  authenticated: true,
  revision: "proxy-rev",
};
const proxySecret = {
  address: proxySettings.address,
  username: "test-user",
  password: "synthetic-password",
};
it("retains the complete proxy when changing destination rules, even with new setup disabled", async () => {
  delete process.env.E2B_BYOP_ENABLED;
  mutation
    .mockReset()
    .mockResolvedValueOnce({
      policy,
      revision: 3,
      status: "applying",
      proxy: proxySettings,
      proxyManaged: true,
    })
    .mockResolvedValue(null);
  jest.mocked(readProxySecret).mockResolvedValue(proxySecret);
  const sandbox = workspace();
  jest.mocked(Sandbox.connect).mockResolvedValue(sandbox as any);
  await saveNetworkSettings("owner", policy, 2);
  expect(sandbox.updateNetwork).toHaveBeenCalledWith(
    {
      allowOut: policy.allow,
      denyOut: ["0.0.0.0/0"],
      egressProxy: proxySecret,
    },
    expect.anything(),
  );
  expect(writeProxySecret).not.toHaveBeenCalled();
});
it("does not acquire or publish direct access when Vault cannot resolve a configured proxy", async () => {
  mutation
    .mockReset()
    .mockResolvedValueOnce({
      policy,
      revision: 3,
      status: "applying",
      proxy: proxySettings,
      proxyManaged: true,
    })
    .mockResolvedValue(null);
  jest
    .mocked(readProxySecret)
    .mockRejectedValue(new Error("synthetic-password"));
  await expect(saveNetworkSettings("owner", policy, 2)).rejects.toThrow(
    "could not be verified",
  );
  expect(Sandbox.list).not.toHaveBeenCalled();
  expect(mutation.mock.calls.at(-1)[1]).toMatchObject({
    success: false,
    releaseLease: true,
  });
  await expect(
    networkForCreation("owner", {
      policy,
      revision: 3,
      status: "ready",
      proxy: proxySettings,
    }),
  ).rejects.toThrow();
});
it("writes rotated credentials even when visible proxy metadata already matches", async () => {
  process.env.E2B_BYOP_ENABLED = "true";
  query.mockResolvedValue({
    policy,
    revision: 2,
    status: "ready",
    proxy: proxySettings,
    proxyManaged: true,
  });
  mutation
    .mockReset()
    .mockResolvedValueOnce({
      policy,
      revision: 3,
      status: "applying",
      proxy: proxySettings,
      proxyManaged: true,
    })
    .mockResolvedValue(null);
  jest.mocked(writeProxySecret).mockResolvedValue(proxySecret);
  const sandbox = workspace();
  await sandbox.updateNetwork({
    allowOut: policy.allow,
    denyOut: ["0.0.0.0/0"],
    egressProxy: proxySecret,
  });
  sandbox.updateNetwork.mockClear();
  jest.mocked(Sandbox.connect).mockResolvedValue(sandbox as any);
  await saveNetworkSettings("owner", policy, 2, {
    address: proxySettings.address,
    credentials: {
      username: proxySecret.username,
      password: proxySecret.password,
    },
  });
  expect(sandbox.updateNetwork).toHaveBeenCalledTimes(1);
  expect(writeProxySecret).toHaveBeenCalled();
  // The persistence mutation must never receive credentials.
  expect(JSON.stringify(mutation.mock.calls)).not.toContain(
    "synthetic-password",
  );
  delete process.env.E2B_BYOP_ENABLED;
});
it("removes a managed proxy while preserving destination rules and deletes its Vault object", async () => {
  query.mockResolvedValue({
    policy,
    revision: 2,
    status: "ready",
    proxy: proxySettings,
    proxyManaged: true,
  });
  mutation
    .mockReset()
    .mockResolvedValueOnce({
      policy,
      revision: 3,
      status: "applying",
      proxy: null,
      proxyManaged: true,
    })
    .mockResolvedValue(null);
  const sandbox = workspace();
  await sandbox.updateNetwork({
    allowOut: policy.allow,
    denyOut: ["0.0.0.0/0"],
    egressProxy: proxySecret,
  });
  sandbox.updateNetwork.mockClear();
  jest.mocked(Sandbox.connect).mockResolvedValue(sandbox as any);
  await saveNetworkSettings("owner", policy, 2, null);
  expect(sandbox.updateNetwork).toHaveBeenCalledWith(
    { allowOut: policy.allow, denyOut: ["0.0.0.0/0"] },
    expect.anything(),
  );
  expect(deleteProxySecret).toHaveBeenCalledWith("owner");
});
it("rejects new proxy setup before persisting anything when capability is disabled", async () => {
  delete process.env.E2B_BYOP_ENABLED;
  await expect(
    saveNetworkSettings("owner", policy, 2, {
      address: proxySettings.address,
      credentials: null,
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(mutation).not.toHaveBeenCalled();
  expect(writeProxySecret).not.toHaveBeenCalled();
});
it("waits for fenced network writers before account secret cleanup and clears the marker only after deletion", async () => {
  query.mockResolvedValueOnce({
    managed: true,
    leaseUntil: Date.now() + 120_000,
  });
  await expect(deleteCloudProxyForAccount("owner")).rejects.toThrow(
    "finishing",
  );
  expect(deleteProxySecret).not.toHaveBeenCalled();
  query.mockResolvedValueOnce({ managed: true });
  jest.mocked(deleteProxySecret).mockResolvedValueOnce(undefined);
  await deleteCloudProxyForAccount("owner");
  expect(deleteProxySecret).toHaveBeenCalledWith("owner");
  expect(mutation).toHaveBeenCalledTimes(1);
});

it("reapplies credentials on reconnect even when a paused sandbox has matching public metadata", async () => {
  query.mockResolvedValue({
    policy,
    revision: 3,
    status: "ready",
    proxy: proxySettings,
    proxyManaged: true,
  });
  mutation
    .mockReset()
    .mockResolvedValueOnce({
      policy,
      revision: 3,
      status: "applying",
      proxy: proxySettings,
      proxyManaged: true,
    })
    .mockResolvedValue(null);
  jest.mocked(readProxySecret).mockResolvedValue(proxySecret);
  const sandbox = workspace();
  await sandbox.updateNetwork({
    allowOut: policy.allow,
    denyOut: ["0.0.0.0/0"],
    egressProxy: { ...proxySecret, password: "old-password" },
  });
  sandbox.updateNetwork.mockClear();
  await ensureCloudNetwork(sandbox as any, "owner");
  expect(sandbox.updateNetwork).toHaveBeenCalledWith(
    expect.objectContaining({ egressProxy: proxySecret }),
    expect.anything(),
  );
  sandbox.updateNetwork.mockClear();
  await ensureCloudNetwork(sandbox as any, "owner");
  expect(sandbox.updateNetwork).not.toHaveBeenCalled();
});

it("waits for a competing network writer when acquiring a proxy sandbox", async () => {
  query.mockResolvedValue({
    policy,
    revision: 3,
    status: "ready",
    proxy: proxySettings,
    proxyManaged: true,
  });
  mutation
    .mockReset()
    .mockRejectedValueOnce(
      new ConvexError(
        "A network update is already running. Try again shortly.",
      ),
    )
    .mockResolvedValueOnce({
      policy,
      revision: 3,
      status: "applying",
      proxy: proxySettings,
      proxyManaged: true,
    })
    .mockResolvedValue(null);
  jest.mocked(readProxySecret).mockResolvedValue(proxySecret);
  const sandbox = workspace();
  await ensureCloudNetwork(sandbox as any, "owner");
  expect(sandbox.updateNetwork).toHaveBeenCalledWith(
    expect.objectContaining({ egressProxy: proxySecret }),
    expect.anything(),
  );
});
