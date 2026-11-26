// Off unless a test opts in: then every store call fails.
let mockFailingStore: { eval: jest.Mock } | null = null;
jest.mock("@/lib/rate-limit/redis", () => {
  const actual = jest.requireActual("@/lib/rate-limit/redis");
  return {
    ...actual,
    createRedisClient: () => mockFailingStore ?? actual.createRedisClient(),
  };
});
jest.mock("../cloud-workspace-routing", () => ({
  resolveCloudWorkspaceRegion: jest.fn(),
}));
import { resolveCloudWorkspaceRegion } from "../cloud-workspace-routing";
jest.mock("@/lib/cloud-recovery/store", () => ({ readFailures: jest.fn() }));
import { readFailures } from "@/lib/cloud-recovery/store";
jest.mock("@/lib/cloud-network/service", () => ({
  readNetworkSettings: jest.fn(async () => null),
  ensureCloudNetwork: jest.fn(async () => {}),
  // The caller projects reports through the service's real closed vocabulary.
  parseCloudNetworkSuboperation: jest.requireActual(
    "@/lib/cloud-network/service",
  ).parseCloudNetworkSuboperation,
}));
import { ensureCloudNetwork } from "@/lib/cloud-network/service";
import { CloudAcquisitionBudget } from "../cloud-acquisition-budget";
import type { Sandbox } from "@e2b/code-interpreter";
import { ensureCloudSandboxConnection } from "../cloud-sandbox";
import { ensureSandboxConnection, E2BAcquisitionError } from "../sandbox";
import { phLogger } from "@/lib/posthog/server";
import {
  assertCloudWorkspaceAvailable,
  CloudWorkspaceUnavailableError,
  readCloudWorkspaceState,
} from "../cloud-workspace-guard";

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: { list: jest.fn(), kill: jest.fn() },
}));
jest.mock("../sandbox", () => ({
  ensureSandboxConnection: jest.fn(),
  E2BAcquisitionError: class E2BAcquisitionError extends Error {},
}));
jest.mock("../cloud-workspace-guard", () => ({
  ...jest.requireActual("../cloud-workspace-guard"),
  readCloudWorkspaceState: jest.fn(),
  assertCloudWorkspaceAvailable: jest.fn(),
  registerE2BWorkspaceLease: jest.fn(),
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));

const ensure = jest.mocked(ensureSandboxConnection);
const read = jest.mocked(readCloudWorkspaceState);
const available = jest.mocked(assertCloudWorkspaceAvailable);
const network = jest.mocked(ensureCloudNetwork);
const failedEvents = () =>
  jest
    .mocked(phLogger.event)
    .mock.calls.filter(([name]) => name === "cloud_sandbox_acquisition_failed")
    .map(([, fields]) => fields as Record<string, unknown>);
const networkFields = (fields: Record<string, unknown> | undefined) =>
  Object.keys(fields ?? {}).filter((key) =>
    key.startsWith("network_verification_"),
  );
/** Reject only the post-connect recheck, never the pre-connect admission. */
const rejectPostConnectAvailability = (error: unknown, sandboxId = "new-e2b") =>
  available.mockImplementation(async (_userId, id) => {
    if (id === sandboxId) throw error;
  });
const recovered = {
  version: 1 as const,
  phase: "e2b" as const,
  token: "owner",
  sourceId: "old-source",
  destinationId: "verified-destination",
  region: "us-east-1" as const,
};

describe("E2B cloud acquisition", () => {
  const originalEnv = process.env;

  it("forwards bounded identity-read diagnostics without changing the original failure", async () => {
    read.mockResolvedValue(recovered);
    const diagnostics = {
      e2b_phase: "connect" as const,
      e2b_error_category: "permanent" as const,
      e2b_workspace_identity_diagnostic_version: 1 as const,
      e2b_workspace_identity_operation: "get_info" as const,
      e2b_workspace_identity_error_kind: "not_found" as const,
      e2b_workspace_identity_requested_target_fingerprint: "a".repeat(64),
      e2b_workspace_identity_requested_cluster: "us" as const,
    };
    const error = Object.assign(
      new E2BAcquisitionError("safe public message", diagnostics),
      { diagnostics },
    );
    ensure.mockRejectedValueOnce(error);
    const setSandbox = jest.fn();
    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox,
        context: {
          chatId: "chat-1",
          triggerRunId: "run-1",
          triggerRegion: "us-east-1",
        },
      }),
    ).rejects.toBe(error);
    expect(phLogger.event).toHaveBeenCalledWith(
      "cloud_sandbox_acquisition_failed",
      expect.objectContaining({
        ...diagnostics,
        trigger_run_id: "run-1",
        cloud_sandbox_acquisition_failed_event_version: 7,
      }),
    );
    expect(setSandbox).not.toHaveBeenCalled();
    expect(ensureCloudNetwork).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    jest
      .mocked(resolveCloudWorkspaceRegion)
      .mockImplementation(async ({ preferredRegion }) => preferredRegion);
    process.env = { ...originalEnv };
    delete process.env.E2B_EU_API_KEY;
    delete process.env.E2B_EU_DOMAIN;
    read.mockResolvedValue({
      version: 1,
      phase: "provisioning",
      step: "reserved",
      token: "creation",
      region: "us-east-1",
    });
    available.mockResolvedValue(undefined);
    ensure.mockResolvedValue({ sandbox: { sandboxId: "new-e2b" } as Sandbox });
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  it("reports a workspace lookup timeout and fences its late result", async () => {
    jest.useFakeTimers();
    let finish!: (value: null) => void;
    read.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const setSandbox = jest.fn();
    try {
      const result = new CloudAcquisitionBudget()
        .run(
          (signal, reportStage) =>
            ensureCloudSandboxConnection({
              userId: "user-1",
              setSandbox,
              signal,
              reportStage,
            }),
          { userId: "user-1" },
        )
        .catch((error) => error);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(await result).toMatchObject({
        acquisitionStage: "workspace_lookup",
      });
      finish(null);
      await jest.advanceTimersByTimeAsync(1);
      expect(ensure).not.toHaveBeenCalled();
      expect(setSandbox).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("publishes only an authorized E2B result with one acquisition outcome", async () => {
    const setSandbox = jest.fn();
    const result = await ensureCloudSandboxConnection({
      userId: "user-1",
      setSandbox,
      context: { triggerRegion: "us-east-1" },
    });
    expect(result.provider).toBe("e2b");
    expect(available).toHaveBeenCalledWith("user-1", "new-e2b");
    expect(setSandbox).toHaveBeenCalledWith(result.sandbox);
    expect(phLogger.event).toHaveBeenCalledWith(
      "cloud_sandbox_acquisition_completed",
      expect.objectContaining({
        sandbox_provider: "e2b",
        preferred_provider: "e2b",
        outcome: "success",
        fallback_used: false,
      }),
    );
    expect(failedEvents()).toEqual([]);
  });

  it("acquires normally when the diagnostic link stores fail", async () => {
    process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED = "true";
    process.env.E2B_EGRESS_RUN_TIMELINE_SHADOW_ENABLED = "true";
    mockFailingStore = {
      eval: jest.fn(() => {
        throw new Error("store down");
      }),
    };
    try {
      const setSandbox = jest.fn();
      const result = await ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox,
        context: {
          chatId: "chat-1",
          triggerRunId: "run-1",
          triggerRegion: "us-east-1",
        },
      });
      expect(setSandbox).toHaveBeenCalledWith(result.sandbox);
      expect(failedEvents()).toEqual([]);
      // The acquisition link and the run timeline both tried and failed.
      const keys = mockFailingStore.eval.mock.calls.map(([, [key]]) => key);
      expect(keys).toEqual([
        expect.stringMatching(/^egress-review:v2:/),
        expect.stringMatching(/^egress-review:timeline:v1:/),
      ]);
    } finally {
      mockFailingStore = null;
    }
  });

  it.each([
    ["us-east-1", "us"],
    ["us-west-2", "us"],
    ["eu-central-1", "eu"],
  ] as const)(
    "verifies a %s workspace's network with the %s cluster it was acquired from",
    async (region, cluster) => {
      process.env.E2B_EU_API_KEY = "test-eu-key";
      read.mockResolvedValue({
        version: 1,
        phase: "provisioning",
        step: "reserved",
        token: "creation",
        region,
      });
      await ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox: jest.fn(),
        context: { triggerRunId: "run-1", triggerRegion: region },
      });
      expect(ensure).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ triggerRegion: region }),
      );
      expect(network).toHaveBeenCalledWith(
        { sandboxId: "new-e2b" },
        "user-1",
        cluster,
        undefined,
        expect.any(Function),
      );
    },
  );

  it("does not publish a workspace whose network policy could not be applied", async () => {
    jest
      .mocked(ensureCloudNetwork)
      .mockRejectedValueOnce(new Error("network unavailable"));
    const setSandbox = jest.fn();
    await expect(
      ensureCloudSandboxConnection({ userId: "user-1", setSandbox }),
    ).rejects.toThrow("network unavailable");
    expect(setSandbox).not.toHaveBeenCalled();
  });

  it("reconnects the exact recovered destination rather than discovering its stale source", async () => {
    read.mockResolvedValue(recovered);
    await ensureCloudSandboxConnection({
      userId: "user-1",
      setSandbox: jest.fn(),
      initialSandbox: { sandboxId: "old-source" } as Sandbox,
      context: { triggerRegion: "us-east-1" },
    });
    expect(ensure).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ destinationId: "verified-destination" }),
    );
  });

  it("does not discover or create when persistent state needs recovery", async () => {
    read.mockRejectedValue(new CloudWorkspaceUnavailableError());
    const setSandbox = jest.fn();
    await expect(
      ensureCloudSandboxConnection({ userId: "user-1", setSandbox }),
    ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
    expect(ensure).not.toHaveBeenCalled();
    expect(setSandbox).not.toHaveBeenCalled();
    expect(
      jest.mocked(phLogger.event).mock.calls.at(-1)?.[1],
    ).not.toHaveProperty("workspace_guard_reason");
  });

  it.each(["cleanup", "deleted"] as const)(
    "attributes a %s workspace rejection without logging the persisted record",
    async (phase) => {
      read.mockResolvedValue({
        version: 1,
        phase,
        token: "private-cleanup-token",
        migration: recovered,
      });
      const setSandbox = jest.fn();
      await expect(
        ensureCloudSandboxConnection({
          userId: "user-1",
          setSandbox,
          context: { chatId: "chat-1", triggerRunId: "run-1" },
        }),
      ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
      expect(ensure).not.toHaveBeenCalled();
      expect(setSandbox).not.toHaveBeenCalled();
      expect(phLogger.event).toHaveBeenCalledWith(
        "cloud_sandbox_acquisition_failed",
        expect.objectContaining({
          userId: "user-1",
          chat_id: "chat-1",
          trigger_run_id: "run-1",
          workspace_guard_reason: "workspace_phase_unavailable",
          workspace_phase: phase,
        }),
      );
      expect(console.warn).toHaveBeenCalledWith(
        "Cloud sandbox acquisition completed",
        expect.objectContaining({
          outcome: "error",
          workspace_guard_reason: "workspace_phase_unavailable",
          workspace_phase: phase,
        }),
      );
      const logged = JSON.stringify([
        jest.mocked(phLogger.event).mock.calls,
        jest.mocked(console.warn).mock.calls,
      ]);
      for (const value of [
        "private-cleanup-token",
        recovered.token,
        recovered.sourceId,
        recovered.destinationId,
      ]) {
        expect(logged).not.toContain(value);
      }
    },
  );

  it.each(["eu-central-1"] as const)(
    "does not reconnect a pin through an unverified or different cluster: %s",
    async (region) => {
      read.mockResolvedValue(recovered);
      process.env.E2B_EU_API_KEY = "test-eu-key";
      process.env.E2B_EU_DOMAIN = "eu.example.test";
      await expect(
        ensureCloudSandboxConnection({
          userId: "user-1",
          setSandbox: jest.fn(),
          context: { triggerRegion: region },
        }),
      ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
      expect(ensure).not.toHaveBeenCalled();
      expect(phLogger.event).toHaveBeenCalledWith(
        "cloud_sandbox_acquisition_failed",
        expect.objectContaining({
          workspace_guard_reason: "workspace_region_mismatch",
          workspace_phase: "e2b",
          workspace_region: "us-east-1",
          trigger_region: region,
        }),
      );
    },
  );

  it("uses the durable recovered region when an Ask caller has no Trigger region", async () => {
    read.mockResolvedValue(recovered);
    await ensureCloudSandboxConnection({
      userId: "user-1",
      setSandbox: jest.fn(),
    });
    expect(ensure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        triggerRegion: recovered.region,
        destinationId: recovered.destinationId,
      }),
    );
  });

  it("does not label different regions in the same E2B cluster as a mismatch", async () => {
    read.mockResolvedValue(recovered);
    const setSandbox = jest.fn();
    await ensureCloudSandboxConnection({
      userId: "user-1",
      setSandbox,
      context: { triggerRegion: "us-west-2" },
    });
    expect(setSandbox).toHaveBeenCalledWith({ sandboxId: "new-e2b" });
    expect(
      jest.mocked(phLogger.event).mock.calls.at(-1)?.[1],
    ).not.toHaveProperty("workspace_guard_reason");
  });

  it("lets an older queued US worker reconnect to the same E2B cluster", async () => {
    read.mockResolvedValue(recovered);
    jest.mocked(resolveCloudWorkspaceRegion).mockResolvedValue("us-east-1");
    const setSandbox = jest.fn();
    await ensureCloudSandboxConnection({
      userId: "user-1",
      setSandbox,
      context: { triggerRunId: "legacy-run", triggerRegion: "us-west-2" },
    });
    expect(ensure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        triggerRegion: "us-east-1",
        destinationId: recovered.destinationId,
      }),
    );
    expect(setSandbox).toHaveBeenCalledWith({ sandboxId: "new-e2b" });
  });
  it.each([undefined, "eu-central-1"] as const)(
    "fences a queued worker with an unverified or different provider cluster: %s",
    async (region) => {
      process.env.E2B_EU_API_KEY = "test-eu-key";
      jest.mocked(resolveCloudWorkspaceRegion).mockResolvedValue("us-east-1");
      await expect(
        ensureCloudSandboxConnection({
          userId: "user-1",
          setSandbox: jest.fn(),
          context: { triggerRunId: "legacy-run", triggerRegion: region },
        }),
      ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
      expect(ensure).not.toHaveBeenCalled();
      expect(phLogger.event).toHaveBeenCalledWith(
        "cloud_sandbox_acquisition_failed",
        expect.objectContaining({
          workspace_guard_reason: region
            ? "workspace_region_mismatch"
            : "trigger_region_missing",
          workspace_region: "us-east-1",
        }),
      );
    },
  );

  it("never publishes a result if cleanup takes ownership during acquisition", async () => {
    available.mockRejectedValue(new CloudWorkspaceUnavailableError());
    const setSandbox = jest.fn();
    await expect(
      ensureCloudSandboxConnection({ userId: "user-1", setSandbox }),
    ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
    expect(setSandbox).not.toHaveBeenCalled();
    expect(
      jest.mocked(phLogger.event).mock.calls.at(-1)?.[1],
    ).not.toHaveProperty("workspace_guard_reason");
  });

  it("fences late results after cancellation without publishing a connection", async () => {
    const controller = new AbortController();
    ensure.mockImplementation(async () => {
      controller.abort();
      return { sandbox: { sandboxId: "late-e2b" } as Sandbox };
    });
    const setSandbox = jest.fn();
    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(setSandbox).not.toHaveBeenCalled();
    expect(
      jest.mocked(phLogger.event).mock.calls.at(-1)?.[1],
    ).not.toHaveProperty("workspace_guard_reason");
  });

  it("attributes the caller's exact abort reason and forwards resume stage options unchanged", async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ private: "PRIVATE_ABORT_REASON" });
    const resume = { resumingPausedWorkspace: true };
    const reportStage = jest.fn();
    ensure.mockImplementationOnce(async (_owner, options) => {
      options?.reportStage?.("connect", resume);
      controller.abort(reason);
      controller.signal.throwIfAborted();
      throw new Error("Owned abort did not throw");
    });
    const publish = jest.fn();
    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox: publish,
        signal: controller.signal,
        reportStage,
      }),
    ).rejects.toBe(reason);
    const events = jest
      .mocked(phLogger.event)
      .mock.calls.filter(
        ([name]) => name === "cloud_sandbox_acquisition_failed",
      );
    expect(events).toHaveLength(1);
    expect(events[0][1]).toMatchObject({
      acquisition_signal_aborted: true,
      acquisition_error_is_signal_reason: true,
      acquisition_thrown_kind: "object",
      acquisition_last_reported_stage: "connect",
    });
    expect(reportStage.mock.calls[0]).toEqual(["workspace_lookup"]);
    expect(reportStage.mock.calls.at(-1)).toEqual(["connect", resume]);
    expect(reportStage.mock.calls.at(-1)?.[1]).toBe(resume);
    expect(
      JSON.stringify(jest.mocked(phLogger.event).mock.calls),
    ).not.toContain("PRIVATE_ABORT_REASON");
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    { pausedResume: true, outcome: "success" },
    { pausedResume: false, outcome: "error" },
    { pausedResume: undefined, outcome: "success" },
  ] as const)(
    "records the selected paused resume ($pausedResume) on a $outcome outcome",
    async ({ pausedResume, outcome }) => {
      const original = new Error("PRIVATE_CONNECT_DETAIL");
      ensure.mockImplementationOnce(async (_owner, options) => {
        if (pausedResume === undefined) options?.reportStage?.("create");
        else
          options?.reportStage?.("connect", {
            resumingPausedWorkspace: pausedResume,
          });
        if (outcome === "error") throw original;
        return { sandbox: { sandboxId: "new-e2b" } as Sandbox };
      });

      const result = ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox: jest.fn(),
      });
      if (outcome === "error") await expect(result).rejects.toBe(original);
      else await result;

      const outcomes = jest
        .mocked(phLogger.event)
        .mock.calls.filter(
          ([name]) => name === "cloud_sandbox_acquisition_completed",
        );
      expect(outcomes).toEqual([
        [
          "cloud_sandbox_acquisition_completed",
          expect.objectContaining({
            outcome,
            cloud_sandbox_acquisition_completed_event_version: 1,
          }),
        ],
      ]);
      if (pausedResume === undefined)
        expect(outcomes[0][1]).not.toHaveProperty(
          "e2b_connect_paused_resume_selected",
        );
      else
        expect(outcomes[0][1]).toHaveProperty(
          "e2b_connect_paused_resume_selected",
          pausedResume,
        );
      expect(JSON.stringify(outcomes)).not.toContain("PRIVATE_CONNECT_DETAIL");
    },
  );

  it("captures abort facts before the failure callback can change the signal", async () => {
    const controller = new AbortController();
    const original = Object.freeze(new Error("PRIVATE_PROVIDER_DETAIL"));
    ensure.mockRejectedValueOnce(original);
    const onFailure = jest.fn(() => controller.abort(original));
    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox: jest.fn(),
        signal: controller.signal,
        context: { onFailure },
      }),
    ).rejects.toBe(original);
    expect(controller.signal.aborted).toBe(true);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(phLogger.event).toHaveBeenCalledWith(
      "cloud_sandbox_acquisition_failed",
      expect.objectContaining({
        acquisition_signal_aborted: false,
        acquisition_error_is_signal_reason: false,
        acquisition_thrown_kind: "error",
        acquisition_last_reported_stage: "workspace_lookup",
      }),
    );
    expect(
      JSON.stringify(jest.mocked(phLogger.event).mock.calls),
    ).not.toContain("PRIVATE_PROVIDER_DETAIL");
    // Failed before verification began: no verification boundary is claimed.
    expect(failedEvents()[0]).not.toHaveProperty(
      "workspace_verification_phase",
    );
    expect(failedEvents()[0]).not.toHaveProperty(
      "workspace_verification_diagnostic_version",
    );
  });

  it("labels a workspace_verification stage callback failure without running later checks", async () => {
    const original = new TypeError("PRIVATE_CALLBACK_DETAIL");
    const reportStage = jest.fn((stage: string) => {
      if (stage === "workspace_verification") throw original;
    });
    const publish = jest.fn();
    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox: publish,
        reportStage,
      }),
    ).rejects.toBe(original);
    expect(reportStage.mock.calls[0]).toEqual(["workspace_lookup"]);
    expect(available).toHaveBeenCalledTimes(1);
    expect(available).not.toHaveBeenCalledWith("user-1", "new-e2b");
    expect(network).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(failedEvents()).toEqual([
      expect.objectContaining({
        acquisition_last_reported_stage: "workspace_verification",
        workspace_verification_diagnostic_version: 1,
        workspace_verification_phase: "stage_report",
        cloud_sandbox_acquisition_failed_event_version: 7,
      }),
    ]);
    expect(JSON.stringify(failedEvents())).not.toContain(
      "PRIVATE_CALLBACK_DETAIL",
    );
  });

  it("labels the post-connect availability rejection, not the network check", async () => {
    const original = new TypeError("PRIVATE_AVAILABILITY_DETAIL");
    rejectPostConnectAvailability(original);
    const publish = jest.fn();
    await expect(
      ensureCloudSandboxConnection({ userId: "user-1", setSandbox: publish }),
    ).rejects.toBe(original);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(available.mock.calls).toEqual([
      ["user-1", undefined],
      ["user-1", "new-e2b"],
    ]);
    expect(network).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(failedEvents()).toEqual([
      expect.objectContaining({
        error_name: "TypeError",
        workspace_verification_diagnostic_version: 1,
        workspace_verification_phase: "availability_check",
      }),
    ]);
    expect(JSON.stringify(failedEvents())).not.toContain(
      "PRIVATE_AVAILABILITY_DETAIL",
    );
  });

  it("labels a network rejection after availability succeeds with no repeated operations", async () => {
    const original = new TypeError("PRIVATE_NETWORK_DETAIL");
    network.mockRejectedValueOnce(original);
    const publish = jest.fn();
    await expect(
      ensureCloudSandboxConnection({ userId: "user-1", setSandbox: publish }),
    ).rejects.toBe(original);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(available).toHaveBeenCalledTimes(2);
    expect(network).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(failedEvents()).toEqual([
      expect.objectContaining({
        error_name: "TypeError",
        workspace_verification_diagnostic_version: 1,
        workspace_verification_phase: "network_check",
        // No step was reported and no direct/first-cause code is readable.
        network_verification_diagnostic_version: 1,
        network_verification_suboperation: "unknown",
        network_verification_transport_code: "none",
      }),
    ]);
    expect(JSON.stringify(failedEvents())).not.toContain(
      "PRIVATE_NETWORK_DETAIL",
    );
  });

  it("labels the latest reported network step and its bounded transport code", async () => {
    const original = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(
        new Error("PRIVATE_CAUSE https://private.example.test/sbx-PRIVATE"),
        { code: "ECONNRESET" },
      ),
    });
    network.mockImplementationOnce(
      async (_sandbox, _user, _cluster, _signal, report) => {
        report?.("settings_read");
        report?.("ready_cache_check");
        report?.("provider_info_read");
        throw original;
      },
    );
    const publish = jest.fn();
    await expect(
      ensureCloudSandboxConnection({ userId: "user-1", setSandbox: publish }),
    ).rejects.toBe(original);
    expect(network).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledWith(
      { sandboxId: "new-e2b" },
      "user-1",
      "us",
      undefined,
      expect.any(Function),
    );
    expect(publish).not.toHaveBeenCalled();
    expect(failedEvents()).toEqual([
      expect.objectContaining({
        error_name: "TypeError",
        workspace_verification_phase: "network_check",
        network_verification_diagnostic_version: 1,
        network_verification_suboperation: "provider_info_read",
        network_verification_transport_code: "ECONNRESET",
        cloud_sandbox_acquisition_failed_event_version: 7,
      }),
    ]);
    const logged = JSON.stringify([
      jest.mocked(phLogger.event).mock.calls,
      jest.mocked(console.warn).mock.calls,
    ]);
    expect(logged).not.toContain("PRIVATE");
    // The existing console outcome record gains no network fields.
    expect(JSON.stringify(jest.mocked(console.warn).mock.calls)).not.toContain(
      "network_verification",
    );
  });

  it.each([
    [
      "an accessor cause without invoking it",
      ["settings_read", "settings_recheck"],
      () => {
        const error = new TypeError("PRIVATE_ACCESSOR_ERROR");
        const cause = jest.fn(() => ({ code: "ECONNRESET" }));
        Object.defineProperty(error, "cause", { get: cause });
        return { error, check: () => expect(cause).not.toHaveBeenCalled() };
      },
      "settings_recheck",
      "unreadable",
    ],
    [
      "a non-allowlisted nested code",
      ["policy_apply"],
      () => ({
        error: Object.assign(new TypeError("PRIVATE_NESTED"), {
          cause: { code: "PRIVATE_CODE", url: "https://private.example.test" },
        }),
      }),
      "policy_apply",
      "other",
    ],
    [
      "a non-TypeError, which has no transport label",
      ["settings_read", "policy_compare"],
      () => ({
        error: Object.assign(new Error("PRIVATE_OWNERSHIP"), {
          code: "ECONNRESET",
        }),
      }),
      "policy_compare",
      undefined,
    ],
    [
      "a proxy whose reflection throws",
      ["post_check"],
      () => ({
        // The projector's first reflection throws; other keys stay readable
        // so the test harness can still compare the rejection.
        error: new Proxy(new TypeError("PRIVATE_PROXY"), {
          getOwnPropertyDescriptor(target, key) {
            if (key === "name") throw new Error("PRIVATE_TRAP");
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        }),
      }),
      "post_check",
      undefined,
    ],
    [
      "an unrecognized step value as unknown",
      ["provider_info_read", "PRIVATE_STEP"],
      () => ({ error: new TypeError("PRIVATE_STEP_ERROR") }),
      "unknown",
      "none",
    ],
  ] as const)(
    "keeps the original network failure and labels %s",
    async (_case, steps, makeError, suboperation, transportCode) => {
      const { error: original, check } = makeError() as {
        error: unknown;
        check?: () => void;
      };
      network.mockImplementationOnce(
        async (_sandbox, _user, _cluster, _signal, report) => {
          for (const step of steps) report?.(step as never);
          throw original;
        },
      );
      const publish = jest.fn();
      await expect(
        ensureCloudSandboxConnection({ userId: "user-1", setSandbox: publish }),
      ).rejects.toBe(original);
      check?.();
      expect(publish).not.toHaveBeenCalled();
      const [event] = failedEvents();
      expect(failedEvents()).toHaveLength(1);
      expect(event).toMatchObject({
        workspace_verification_phase: "network_check",
        network_verification_diagnostic_version: 1,
        network_verification_suboperation: suboperation,
      });
      if (transportCode === undefined)
        expect(event).not.toHaveProperty("network_verification_transport_code");
      else
        expect(event.network_verification_transport_code).toBe(transportCode);
      expect(JSON.stringify(failedEvents())).not.toContain("PRIVATE");
    },
  );

  it("does not carry network step fields into later phases or success", async () => {
    network.mockImplementation(
      async (_sandbox, _user, _cluster, _signal, report) => {
        report?.("post_check");
      },
    );
    const original = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET" },
    });
    const publish = jest.fn(() => {
      throw original;
    });
    await expect(
      ensureCloudSandboxConnection({ userId: "user-1", setSandbox: publish }),
    ).rejects.toBe(original);
    expect(failedEvents()).toEqual([
      expect.objectContaining({ workspace_verification_phase: "post_checks" }),
    ]);
    expect(networkFields(failedEvents()[0])).toEqual([]);

    jest.mocked(phLogger.event).mockClear();
    await ensureCloudSandboxConnection({
      userId: "user-1",
      setSandbox: jest.fn(),
    });
    expect(failedEvents()).toEqual([]);
    for (const [, fields] of jest.mocked(phLogger.event).mock.calls)
      expect(networkFields(fields as Record<string, unknown>)).toEqual([]);
  });

  it("labels an abort that lands after the network check as post_checks", async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ private: "PRIVATE_LATE_ABORT" });
    network.mockImplementationOnce(async () => {
      controller.abort(reason);
    });
    const publish = jest.fn();
    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox: publish,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(publish).not.toHaveBeenCalled();
    expect(failedEvents()).toEqual([
      expect.objectContaining({
        acquisition_signal_aborted: true,
        acquisition_error_is_signal_reason: true,
        workspace_verification_phase: "post_checks",
      }),
    ]);
  });

  it("labels a publication failure as post_checks and keeps the original exception", async () => {
    const original = new TypeError("PRIVATE_PUBLISH_DETAIL");
    const publish = jest.fn(() => {
      throw original;
    });
    await expect(
      ensureCloudSandboxConnection({ userId: "user-1", setSandbox: publish }),
    ).rejects.toBe(original);
    expect(network).toHaveBeenCalledTimes(1);
    expect(failedEvents()).toEqual([
      expect.objectContaining({
        workspace_verification_diagnostic_version: 1,
        workspace_verification_phase: "post_checks",
      }),
    ]);
  });

  it("captures the verification phase before failure cleanup aborts the signal", async () => {
    const controller = new AbortController();
    const original = new TypeError("PRIVATE_CLEANUP_DETAIL");
    network.mockRejectedValueOnce(original);
    const onFailure = jest.fn(() => controller.abort(original));
    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox: jest.fn(),
        signal: controller.signal,
        context: { onFailure },
      }),
    ).rejects.toBe(original);
    expect(controller.signal.aborted).toBe(true);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(failedEvents()).toEqual([
      expect.objectContaining({
        acquisition_signal_aborted: false,
        acquisition_error_is_signal_reason: false,
        acquisition_last_reported_stage: "workspace_verification",
        workspace_verification_phase: "network_check",
      }),
    ]);
    expect(JSON.stringify(failedEvents())).not.toContain(
      "PRIVATE_CLEANUP_DETAIL",
    );
  });

  it("keeps each overlapping acquisition's verification phase separate", async () => {
    let releaseNetwork!: () => void;
    const networkFailure = new TypeError("first");
    const availabilityFailure = new TypeError("second");
    ensure
      .mockResolvedValueOnce({ sandbox: { sandboxId: "first-e2b" } as Sandbox })
      .mockResolvedValueOnce({
        sandbox: { sandboxId: "second-e2b" } as Sandbox,
      });
    rejectPostConnectAvailability(availabilityFailure, "second-e2b");
    let networkEntered!: () => void;
    const firstInNetwork = new Promise<void>((resolve) => {
      networkEntered = resolve;
    });
    network.mockImplementationOnce(async () => {
      networkEntered();
      await new Promise<void>((resolve) => {
        releaseNetwork = resolve;
      });
      throw networkFailure;
    });
    const first = ensureCloudSandboxConnection({
      userId: "user-1",
      setSandbox: jest.fn(),
    }).catch((error) => error);
    await firstInNetwork;
    // The second acquisition advances further in source order while the
    // first is still parked in the network check.
    await expect(
      ensureCloudSandboxConnection({ userId: "user-1", setSandbox: jest.fn() }),
    ).rejects.toBe(availabilityFailure);
    releaseNetwork();
    expect(await first).toBe(networkFailure);
    const [second, firstEvent] = failedEvents();
    expect(second).toMatchObject({
      workspace_verification_phase: "availability_check",
    });
    expect(firstEvent).toMatchObject({
      workspace_verification_phase: "network_check",
    });
    expect(firstEvent.acquisition_id).not.toBe(second.acquisition_id);
  });

  it("distinguishes an unrelated rejection while the caller signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = "PRIVATE_CALLER_REASON";
    const original = Object.freeze({ private: "PRIVATE_OTHER_FAILURE" });
    ensure.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw original;
    });
    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox: jest.fn(),
        signal: controller.signal,
      }),
    ).rejects.toBe(original);
    expect(phLogger.event).toHaveBeenCalledWith(
      "cloud_sandbox_acquisition_failed",
      expect.objectContaining({
        acquisition_signal_aborted: true,
        acquisition_error_is_signal_reason: false,
        acquisition_thrown_kind: "object",
      }),
    );
    const serialized = JSON.stringify(jest.mocked(phLogger.event).mock.calls);
    expect(serialized).not.toContain(reason);
    expect(serialized).not.toContain("PRIVATE_OTHER_FAILURE");
  });

  it.each([
    ["PRIVATE_REJECTION", "string"],
    [null, "null"],
    [undefined, "undefined"],
    [13, "number"],
    [true, "boolean"],
    [13n, "bigint"],
    [Symbol("PRIVATE_SYMBOL"), "symbol"],
  ] as const)(
    "records only a finite kind for a non-Error rejection: %s",
    async (original, kind) => {
      ensure.mockRejectedValueOnce(original);
      await expect(
        ensureCloudSandboxConnection({
          userId: "user-1",
          setSandbox: jest.fn(),
        }),
      ).rejects.toBe(original);
      expect(phLogger.event).toHaveBeenCalledWith(
        "cloud_sandbox_acquisition_failed",
        expect.objectContaining({
          acquisition_signal_aborted: false,
          acquisition_error_is_signal_reason: false,
          acquisition_thrown_kind: kind,
        }),
      );
      const serialized = JSON.stringify(jest.mocked(phLogger.event).mock.calls);
      expect(serialized).not.toContain("PRIVATE_REJECTION");
      expect(serialized).not.toContain("PRIVATE_SYMBOL");
    },
  );
});

it("pins ordinary retries to a failed workspace even if discovery would return empty", async () => {
  const original = process.env.CLOUD_DISK_RECOVERY_TARGETS;
  process.env.CLOUD_DISK_RECOVERY_TARGETS = "configured";
  read.mockResolvedValue({
    ...recovered,
    sourceId: "failed-existing",
    destinationId: "failed-existing",
    origin: "adopted",
  });
  available.mockResolvedValue(undefined);
  jest.mocked(readFailures).mockResolvedValue({
    sandboxId: "failed-existing",
    region: "us-east-1",
  } as never);
  ensure.mockRejectedValueOnce(new Error("workspace not found"));
  const publish = jest.fn();
  try {
    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox: publish,
        context: { triggerRegion: "us-east-1" },
      }),
    ).rejects.toThrow("workspace not found");
    expect(ensure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ destinationId: "failed-existing" }),
    );
    expect(publish).not.toHaveBeenCalled();
  } finally {
    if (original === undefined) delete process.env.CLOUD_DISK_RECOVERY_TARGETS;
    else process.env.CLOUD_DISK_RECOVERY_TARGETS = original;
  }
});
