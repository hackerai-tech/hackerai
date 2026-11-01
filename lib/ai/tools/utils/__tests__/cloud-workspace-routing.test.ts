import { Sandbox } from "@e2b/code-interpreter";
import { resolveCloudWorkspaceRegion } from "../cloud-workspace-routing";
import { CloudWorkspaceUnavailableError } from "../cloud-workspace-guard";
import {
  CloudAcquisitionBudget,
  CloudAcquisitionTimeoutError,
  CLOUD_ACQUISITION_DEADLINE_MS,
} from "../cloud-acquisition-budget";

jest.mock("@e2b/code-interpreter", () => ({ Sandbox: { list: jest.fn() } }));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));
const mockData = new Map<string, unknown>();
const mockSet = jest.fn();
const mockGet = jest.fn();
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => ({
    get: (key: string) => mockGet(key),
    set: mockSet,
  }),
}));
const regionKey = "cloud_workspace_region:v1:owner";
const stateKey = "cloud_workspace_migration:v1:owner";
const failedKey = "cloud_resume_failures:v1:owner";
const workspace = {
  version: 1,
  phase: "e2b",
  token: "owner-token",
  sourceId: "retained",
  destinationId: "original-files",
  region: "us-east-1",
};
const failed = {
  sandboxId: "original-files",
  region: "us-east-1",
  template: "template",
  sandboxVersion: "v12",
  attempts: ["7ad19af5-4d14-4d4b-aab7-90734610a6da"],
  uncertain: true,
  timeoutOnly: true,
  lastFailedAt: Date.now(),
};
const resolve = (
  preferredRegion: "us-east-1" | "eu-central-1",
  signal?: AbortSignal,
) => resolveCloudWorkspaceRegion({ userId: "owner", preferredRegion, signal });
const inventory = (clusters: string[]) => {
  jest.mocked(Sandbox.list).mockImplementation(
    (options) =>
      ({
        hasNext: false,
        nextItems: async () =>
          clusters.includes(options?.domain ? "eu" : "us")
            ? [{ sandboxId: "original-files", metadata: { userID: "owner" } }]
            : [],
      }) as never,
  );
};
const env = process.env;
let warning: jest.SpyInstance;
beforeEach(() => {
  jest.resetAllMocks();
  warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  mockData.clear();
  mockGet.mockImplementation(async (key: string) => mockData.get(key) ?? null);
  process.env = {
    ...env,
    E2B_API_KEY: "synthetic-us",
    E2B_EU_API_KEY: "synthetic-eu",
    CLOUD_DISK_RECOVERY_TARGETS: "configured",
  };
  mockSet.mockImplementation(async (key: string, value: unknown) => {
    if (!mockData.has(key)) mockData.set(key, value);
  });
  inventory([]);
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  process.env = env;
});

it("keeps the first workspace region across request-location changes and returning visits", async () => {
  expect(await resolve("eu-central-1")).toBe("eu-central-1");
  expect(await resolve("us-east-1")).toBe("eu-central-1");
  expect(warning).not.toHaveBeenCalled();
  expect(mockSet).toHaveBeenCalledWith(regionKey, "eu-central-1", { nx: true });
  // A returning visit reads the durable binding without depending on either provider.
  jest.mocked(Sandbox.list).mockImplementation(() => {
    throw new Error("offline");
  });
  expect(await resolve("us-east-1")).toBe("eu-central-1");
});
it("adopts legacy paused files from their actual cluster instead of the request IP", async () => {
  inventory(["eu"]);
  expect(await resolve("us-east-1")).toBe("eu-central-1");
  expect(mockData.get(regionKey)).toBe("eu-central-1");
  expect(Sandbox.list).toHaveBeenCalledWith(
    expect.objectContaining({
      query: { metadata: { userID: "owner" }, state: ["running", "paused"] },
    }),
  );
});
it("concurrent first visits converge on the stored winner", async () => {
  const results = await Promise.all([
    resolve("us-east-1"),
    resolve("eu-central-1"),
  ]);
  expect(results[0]).toBe(results[1]);
  expect(results[0]).toBe(mockData.get(regionKey));
});
it.each(["recovered", "failed"])(
  "preserves a %s workspace even when the user changes location",
  async (kind) => {
    mockData.set(
      kind === "recovered" ? stateKey : failedKey,
      kind === "recovered" ? workspace : failed,
    );
    expect(await resolve("eu-central-1")).toBe("us-east-1");
    expect(Sandbox.list).not.toHaveBeenCalled();
  },
);
it.each([
  ["two-clusters", "inventory_multiple_clusters"],
  ["unknown-owner", "inventory_owner_mismatch"],
  ["incomplete", "inventory_incomplete"],
  ["unavailable", undefined],
  ["corrupt-binding", "stored_region_invalid"],
  ["conflicting-evidence", "recovery_evidence_conflict"],
])(
  "does not guess placement or write a binding on %s",
  async (condition, reason) => {
    if (condition === "two-clusters") inventory(["us", "eu"]);
    if (condition === "unknown-owner")
      jest.mocked(Sandbox.list).mockReturnValue({
        hasNext: false,
        nextItems: async () => [{ metadata: { userID: "other" } }],
      } as never);
    if (condition === "incomplete")
      jest
        .mocked(Sandbox.list)
        .mockReturnValue({ hasNext: true, nextItems: async () => [] } as never);
    if (condition === "unavailable")
      jest.mocked(Sandbox.list).mockImplementation(() => {
        throw new Error("read failed");
      });
    if (condition === "corrupt-binding") mockData.set(regionKey, "unknown");
    if (condition === "conflicting-evidence") {
      mockData.set(stateKey, workspace);
      mockData.set(failedKey, { ...failed, region: "eu-central-1" });
    }
    await expect(resolve("us-east-1")).rejects.toThrow();
    expect(mockSet).not.toHaveBeenCalled();
    if (reason) {
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        "Cloud workspace routing unavailable",
        {
          event: "cloud_workspace_routing_unavailable",
          reason,
          user_id: "owner",
        },
      );
    } else {
      // Provider exceptions still propagate without being reclassified as a guard rejection.
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        "Cloud workspace routing operation failed",
        {
          event: "cloud_workspace_routing_operation_failed",
          phase: "inventory_list",
          inventory_cluster: "us",
          error_kind: "other",
          request_aborted: false,
          user_id: "owner",
        },
      );
    }
  },
);
it("rejects a competing binding that would hide discovered files", async () => {
  inventory(["eu"]);
  mockSet.mockImplementation(async () => {
    mockData.set(regionKey, "us-east-1");
  });
  await expect(resolve("us-east-1")).rejects.toBeInstanceOf(
    CloudWorkspaceUnavailableError,
  );
  expect(warning).toHaveBeenCalledWith("Cloud workspace routing unavailable", {
    event: "cloud_workspace_routing_unavailable",
    reason: "claimed_region_conflict",
    user_id: "owner",
  });
});
it("does not save late discovery after cancellation", async () => {
  const controller = new AbortController();
  jest.mocked(Sandbox.list).mockReturnValue({
    hasNext: false,
    nextItems: async () => {
      controller.abort();
      return [];
    },
  } as never);
  await expect(resolve("us-east-1", controller.signal)).rejects.toThrow();
  expect(mockSet).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(
    "Cloud workspace routing operation failed",
    {
      event: "cloud_workspace_routing_operation_failed",
      phase: "inventory_list",
      error_kind: "abort",
      request_aborted: true,
      user_id: "owner",
    },
  );
});

it("preserves an inventory exception without logging its private message", async () => {
  const failure = new Error("private-provider-failure");
  const userId = `user_${"a".repeat(200)}`;
  jest.mocked(Sandbox.list).mockImplementation(() => {
    throw failure;
  });
  await expect(
    resolveCloudWorkspaceRegion({ userId, preferredRegion: "us-east-1" }),
  ).rejects.toBe(failure);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(
    "Cloud workspace routing operation failed",
    {
      event: "cloud_workspace_routing_operation_failed",
      phase: "inventory_list",
      inventory_cluster: "us",
      error_kind: "other",
      request_aborted: false,
      user_id: userId.slice(0, 128),
    },
  );
  expect(JSON.stringify(warning.mock.calls)).not.toContain(
    "private-provider-failure",
  );
  expect(mockSet).not.toHaveBeenCalled();
});

it("does not misattribute a late inventory result after a provider rejection", async () => {
  const failure = new Error("private-provider-failure");
  let finishLate!: (items: { metadata: { userID: string } }[]) => void;
  const late = new Promise<{ metadata: { userID: string } }[]>((resolve) => {
    finishLate = resolve;
  });
  jest.mocked(Sandbox.list).mockImplementation(
    (options) =>
      ({
        hasNext: false,
        nextItems: () => (options?.domain ? late : Promise.reject(failure)),
      }) as never,
  );
  await expect(resolve("us-east-1")).rejects.toBe(failure);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(
    "Cloud workspace routing operation failed",
    {
      event: "cloud_workspace_routing_operation_failed",
      phase: "inventory_list",
      inventory_cluster: "us",
      error_kind: "other",
      request_aborted: false,
      user_id: "owner",
    },
  );
  const firstDiagnostic = JSON.stringify(warning.mock.calls);
  finishLate([{ metadata: { userID: "other" } }]);
  await late;
  await Promise.resolve();
  expect(JSON.stringify(warning.mock.calls)).toBe(firstDiagnostic);
  expect(mockSet).not.toHaveBeenCalled();
});

it("keeps a rejected workspace fenced when diagnostic output fails", async () => {
  mockData.set(regionKey, "invalid");
  warning.mockImplementation(() => {
    throw new Error("diagnostic sink unavailable");
  });
  await expect(resolve("us-east-1")).rejects.toBeInstanceOf(
    CloudWorkspaceUnavailableError,
  );
  expect(mockSet).not.toHaveBeenCalled();
});

it("keeps the first provider rejection ahead of a concurrent invalid inventory", async () => {
  const failure = new DOMException("private-provider-detail", "TimeoutError");
  jest.mocked(Sandbox.list).mockImplementation(
    (options) =>
      ({
        hasNext: false,
        nextItems: () =>
          options?.domain
            ? Promise.resolve([{ metadata: { userID: "other" } }])
            : Promise.reject(failure),
      }) as never,
  );
  await expect(resolve("us-east-1")).rejects.toBe(failure);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(
    "Cloud workspace routing operation failed",
    {
      event: "cloud_workspace_routing_operation_failed",
      phase: "inventory_list",
      inventory_cluster: "us",
      error_kind: "timeout",
      request_aborted: false,
      user_id: "owner",
    },
  );
  expect(mockSet).not.toHaveBeenCalled();
});

it("reports a bounded owner identifier without serializing invalid workspace data", async () => {
  const userId = `user_${"a".repeat(200)}`;
  mockData.set(`cloud_workspace_region:v1:${userId}`, {
    private: "sensitive-workspace-material",
  });
  await expect(
    resolveCloudWorkspaceRegion({ userId, preferredRegion: "us-east-1" }),
  ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
  expect(warning).toHaveBeenCalledWith("Cloud workspace routing unavailable", {
    event: "cloud_workspace_routing_unavailable",
    reason: "stored_region_invalid",
    user_id: userId.slice(0, 128),
  });
  expect(JSON.stringify(warning.mock.calls)).not.toContain(
    "sensitive-workspace-material",
  );
  expect(mockSet).not.toHaveBeenCalled();
});

it.each([
  "region_binding_read",
  "region_binding_claim",
  "region_binding_confirm",
])("attributes a %s dependency failure without changing it", async (phase) => {
  const failure = new DOMException("private-store-detail", "TimeoutError");
  let regionReads = 0;
  mockGet.mockImplementation(async (key: string) => {
    if (key === regionKey) {
      regionReads++;
      if (
        phase === "region_binding_read" ||
        (phase === "region_binding_confirm" && regionReads === 2)
      ) {
        throw failure;
      }
    }
    return mockData.get(key) ?? null;
  });
  if (phase === "region_binding_claim") mockSet.mockRejectedValue(failure);

  await expect(resolve("us-east-1")).rejects.toBe(failure);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(
    "Cloud workspace routing operation failed",
    {
      event: "cloud_workspace_routing_operation_failed",
      phase,
      error_kind: "timeout",
      request_aborted: false,
      user_id: "owner",
    },
  );
  expect(JSON.stringify(warning.mock.calls)).not.toContain(
    "private-store-detail",
  );
  if (phase === "region_binding_read") expect(mockSet).not.toHaveBeenCalled();
});

it("distinguishes an inventory cancellation from a timeout without retrying", async () => {
  const controller = new AbortController();
  const failure = new DOMException("private-cancellation-detail", "AbortError");
  jest.mocked(Sandbox.list).mockReturnValue({
    hasNext: false,
    nextItems: async () => {
      controller.abort(failure);
      throw failure;
    },
  } as never);

  await expect(resolve("us-east-1", controller.signal)).rejects.toBe(failure);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(
    "Cloud workspace routing operation failed",
    {
      event: "cloud_workspace_routing_operation_failed",
      phase: "inventory_list",
      error_kind: "abort",
      request_aborted: true,
      user_id: "owner",
    },
  );
  expect(Sandbox.list).toHaveBeenCalledTimes(2);
  expect(mockSet).not.toHaveBeenCalled();
  expect(JSON.stringify(warning.mock.calls)).not.toContain(
    "private-cancellation-detail",
  );
});

it("preserves a provider exception when operation diagnostics fail", async () => {
  const failure = new Error("private-provider-detail");
  jest.mocked(Sandbox.list).mockImplementation(() => {
    throw failure;
  });
  warning.mockImplementation(() => {
    throw new Error("sink unavailable");
  });
  await expect(resolve("us-east-1")).rejects.toBe(failure);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(mockSet).not.toHaveBeenCalled();
});

it("classifies an acquisition-budget error returned by inventory as a timeout", async () => {
  const failure = new CloudAcquisitionTimeoutError("routing");
  jest.mocked(Sandbox.list).mockReturnValue({
    hasNext: false,
    nextItems: async () => {
      throw failure;
    },
  } as never);
  await expect(resolve("us-east-1")).rejects.toBe(failure);
  expect(warning).toHaveBeenCalledWith(
    "Cloud workspace routing operation failed",
    expect.objectContaining({
      phase: "inventory_list",
      inventory_cluster: "us",
      error_kind: "timeout",
      request_aborted: false,
    }),
  );
  expect(mockSet).not.toHaveBeenCalled();
});

it.each(["TimeoutError", "AbortError"])(
  "keeps only the closed %s category when a state read is fenced",
  async (name) => {
    const failure = new DOMException("private-state-read-detail", name);
    mockGet.mockRejectedValue(failure);
    const caught = await resolve("us-east-1").catch((error) => error);
    expect(caught).toBeInstanceOf(CloudWorkspaceUnavailableError);
    expect(Object.keys(caught)).toEqual(["name"]);
    expect(caught.cause).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      "Cloud workspace routing operation failed",
      {
        event: "cloud_workspace_routing_operation_failed",
        phase: "workspace_state_read",
        error_kind: name === "TimeoutError" ? "timeout" : "abort",
        request_aborted: false,
        user_id: "owner",
      },
    );
    expect(JSON.stringify([caught, warning.mock.calls])).not.toContain(
      "private-state-read-detail",
    );
    expect(mockSet).not.toHaveBeenCalled();
  },
);

it.each(["region_binding_read", "region_binding_claim"])(
  "reports a pending %s when the existing acquisition deadline wins",
  async (phase) => {
    jest.useFakeTimers();
    try {
      let finish!: (value?: unknown) => void;
      if (phase === "region_binding_read") {
        mockGet.mockImplementation(async (key: string) =>
          key === regionKey
            ? new Promise((complete) => {
                finish = complete;
              })
            : (mockData.get(key) ?? null),
        );
      } else {
        mockSet.mockImplementation(
          () =>
            new Promise((complete) => {
              finish = complete;
            }),
        );
      }
      const result = new CloudAcquisitionBudget()
        .run(
          async (signal, reportStage) => {
            reportStage("routing");
            return resolve("us-east-1", signal);
          },
          { userId: "owner" },
        )
        .catch((error) => error);
      await jest.advanceTimersByTimeAsync(CLOUD_ACQUISITION_DEADLINE_MS);
      expect(await result).toBeInstanceOf(CloudAcquisitionTimeoutError);
      expect(await result).toMatchObject({ acquisitionStage: "routing" });
      expect(warning).toHaveBeenCalledWith(
        "Cloud workspace routing operation failed",
        {
          event: "cloud_workspace_routing_operation_failed",
          phase,
          error_kind: "timeout",
          request_aborted: true,
          user_id: "owner",
        },
      );
      const operationWarnings = () =>
        warning.mock.calls.filter(
          ([message]) => message === "Cloud workspace routing operation failed",
        );
      expect(operationWarnings()).toHaveLength(1);
      mockData.set(regionKey, "us-east-1");
      finish("us-east-1");
      await jest.advanceTimersByTimeAsync(0);
      expect(operationWarnings()).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  },
);

it("removes phase observers after successful routing", async () => {
  const controller = new AbortController();
  await expect(resolve("us-east-1", controller.signal)).resolves.toBe(
    "us-east-1",
  );
  controller.abort(new DOMException("later abort", "AbortError"));
  expect(warning).not.toHaveBeenCalled();
});

it("offers an explicit workspace choice instead of a generic startup failure for two existing regions", async () => {
  inventory(["us", "eu"]);
  const error = await resolve("us-east-1").catch((error) => error);
  expect(error).toMatchObject({
    type: "bad_request",
    surface: "sandbox",
    metadata: { cloud_workspace_region_selection_required: true },
  });
  expect(mockSet).not.toHaveBeenCalled();
});
