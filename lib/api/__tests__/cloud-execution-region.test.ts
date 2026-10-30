jest.mock("@/lib/ai/tools/utils/cloud-workspace-guard", () => ({
  readCloudWorkspaceState: jest.fn(),
  CloudWorkspaceUnavailableError: class extends Error {},
}));
jest.mock("@/lib/cloud-recovery/store", () => ({ readFailures: jest.fn() }));

import { resolveCloudExecutionRegion } from "../cloud-execution-region";
import { readCloudWorkspaceState } from "@/lib/ai/tools/utils/cloud-workspace-guard";
import { readFailures } from "@/lib/cloud-recovery/store";

const readWorkspace = jest.mocked(readCloudWorkspaceState);
const readFailed = jest.mocked(readFailures);
const originalConfig = process.env.CLOUD_DISK_RECOVERY_TARGETS;
const uid = "user_test";

beforeEach(() => {
  jest.resetAllMocks();
  delete process.env.CLOUD_DISK_RECOVERY_TARGETS;
  readWorkspace.mockResolvedValue(null);
});
afterAll(() => {
  if (originalConfig === undefined)
    delete process.env.CLOUD_DISK_RECOVERY_TARGETS;
  else process.env.CLOUD_DISK_RECOVERY_TARGETS = originalConfig;
});

test.each([
  ["eu-central-1", "us-west-2"],
  ["us-east-1", "eu-central-1"],
] as const)(
  "keeps pinned %s workspace despite request from %s",
  async (region, requestRegion) => {
    readWorkspace.mockResolvedValue({
      version: 1,
      phase: "e2b",
      token: "pin",
      sourceId: "source",
      destinationId: "destination",
      region,
    });
    expect(
      await resolveCloudExecutionRegion({ userId: uid, requestRegion }),
    ).toBe(region);
    expect(readFailed).not.toHaveBeenCalled();
  },
);

test("uses request placement for a new Cloud workspace", async () => {
  expect(
    await resolveCloudExecutionRegion({
      userId: uid,
      requestRegion: "us-west-2",
    }),
  ).toBe("us-west-2");
});

test("Ask remains available when the Cloud workspace store is unavailable", async () => {
  readWorkspace.mockRejectedValue(new Error("store unavailable"));
  expect(
    await resolveCloudExecutionRegion({
      userId: uid,
      mode: "ask",
      requestRegion: "us-west-2",
    }),
  ).toBe("us-west-2");
  expect(readWorkspace).not.toHaveBeenCalled();
  expect(readFailed).not.toHaveBeenCalled();
});

test.each(["desktop", "environment:local", "desktop-environment:host"])(
  "does not read or apply Cloud state to %s",
  async (sandboxPreference) => {
    expect(
      await resolveCloudExecutionRegion({
        userId: uid,
        sandboxPreference,
        requestRegion: "us-west-2",
      }),
    ).toBe("us-west-2");
    expect(readWorkspace).not.toHaveBeenCalled();
    expect(readFailed).not.toHaveBeenCalled();
  },
);

test.each(["cleanup", "deleted"] as const)(
  "does not admit a %s workspace",
  async (phase) => {
    readWorkspace.mockResolvedValue({ version: 1, phase, token: "fence" });
    await expect(
      resolveCloudExecutionRegion({ userId: uid, requestRegion: "us-east-1" }),
    ).rejects.toThrow();
  },
);

test("does not fall back on an unavailable workspace store", async () => {
  readWorkspace.mockRejectedValue(new Error("store unavailable"));
  await expect(
    resolveCloudExecutionRegion({ userId: uid, requestRegion: "us-east-1" }),
  ).rejects.toThrow("store unavailable");
});

test("uses the failed workspace region for an ordinary pinned retry", async () => {
  process.env.CLOUD_DISK_RECOVERY_TARGETS = "configured";
  readFailed.mockResolvedValue({ region: "eu-central-1" } as Awaited<
    ReturnType<typeof readFailures>
  >);
  expect(
    await resolveCloudExecutionRegion({
      userId: uid,
      sandboxPreference: "e2b",
      requestRegion: "us-west-2",
    }),
  ).toBe("eu-central-1");
});
