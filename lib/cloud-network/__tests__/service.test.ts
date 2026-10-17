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
    expect(mutation.mock.calls[1][1]).toMatchObject({ success: false });
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
