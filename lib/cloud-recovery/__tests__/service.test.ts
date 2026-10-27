import { createHmac } from "node:crypto";
import { resolveCurrentAgentEntitlementContext } from "@/lib/auth/agent-auto-review-entitlements";
import {
  Sandbox,
  SandboxError,
  ServiceBusyError,
  RateLimitError,
  AuthenticationError,
  NotFoundError,
} from "@e2b/code-interpreter";
import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";
import {
  getActiveTriggerRunsForUser,
  getCurrentAgentEntitlementContext,
} from "@/lib/db/actions";
import { listActiveSubagentsForUser } from "@/lib/db/subagents";
import {
  readCloudWorkspaceState,
  readE2BDiskRecoveryResult,
} from "@/lib/ai/tools/utils/cloud-workspace-guard";
import { recoverE2BDiskOnly } from "@/lib/ai/tools/utils/e2b-disk-recovery";
import {
  readConsent,
  readFailures,
  recoveryRedis,
  offerConsent,
  decideConsent,
  failConsent,
  renewConsent,
} from "../store";
import {
  recoveryView,
  confirmRecovery,
  executeCustomerRecovery,
  reopenRecovery,
} from "../service";

// Template parsing is unrelated to status reads; keep the SDK's real error types.
jest.mock("dockerfile-ast", () => ({}));
jest.mock("@e2b/code-interpreter", () => ({
  ...jest.requireActual("@e2b/code-interpreter"),
  Sandbox: { getInfo: jest.fn(), list: jest.fn() },
}));
jest.mock("@/lib/posthog/server", () => ({
  getPostHogBooleanFlagDecisionForUser: jest.fn(),
  phLogger: { event: jest.fn() },
}));
jest.mock("@/lib/db/actions", () => ({
  getActiveTriggerRunsForUser: jest.fn(),
  getCurrentAgentEntitlementContext: jest.fn(),
}));
jest.mock("@/lib/db/subagents", () => ({
  listActiveSubagentsForUser: jest.fn(),
}));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanMakeCostIncurringRequest: jest.fn(),
}));
jest.mock("@/lib/ai/tools/utils/cloud-workspace-guard", () => ({
  readCloudWorkspaceState: jest.fn(),
  readE2BDiskRecoveryResult: jest.fn(),
}));
jest.mock("@/lib/ai/tools/utils/e2b-disk-recovery", () => ({
  ...jest.requireActual("@/lib/ai/tools/utils/e2b-disk-recovery"),
  recoverE2BDiskOnly: jest.fn(),
}));
jest.mock("../store", () => ({
  ...jest.requireActual("../store"),
  readConsent: jest.fn(),
  readFailures: jest.fn(),
  recoveryRedis: jest.fn(),
  offerConsent: jest.fn(),
  decideConsent: jest.fn(),
  failConsent: jest.fn(),
  renewConsent: jest.fn(),
}));
const token = "7ad19af5-4d14-4d4b-aab7-90734610a6da";
const target = {
  sandboxId: "synthetic",
  region: "us-east-1" as const,
  template: "terminal-agent-sandbox",
  sandboxVersion: "v12",
  attempts: [token, "6ad19af5-4d14-4d4b-aab7-90734610a6da"],
  uncertain: false,
  lastFailedAt: Date.now(),
};
const consent = {
  token,
  organizationId: "org-owner",
  target,
  status: "offered" as const,
  issuedAt: Date.now(),
};
const info = {
  sandboxId: "synthetic",
  state: "paused",
  metadata: {
    userID: "owner",
    template: target.template,
    sandboxVersion: "v12",
    e2bCluster: "us",
  },
  lifecycle: { autoResume: false, onTimeout: "pause" },
};
const exists = jest.fn();
const prior = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...prior,
    HACKERAI_ENVIRONMENT: "preview",
    E2B_API_KEY: "synthetic-key",
    UPSTASH_REDIS_REST_URL: "https://synthetic.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "synthetic-token",
    NEXT_PUBLIC_CONVEX_URL: "https://synthetic.convex.cloud",
    NEXT_PUBLIC_POSTHOG_KEY: "synthetic-project",
  };
  process.env.CLOUD_DISK_RECOVERY_TARGETS = JSON.stringify({
    "us-east-1": {
      environment: "preview",
      e2bAccount: "synthetic-account",
      e2bProject: "synthetic-project",
      expectedApiKeyHmacSha256: createHmac("sha256", "synthetic-key")
        .update("hackerai-e2b-disk-recovery-target-v1")
        .digest("hex"),
      expectedRedisHost: "synthetic.upstash.io",
      expectedConvexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
      expectedDomain: "e2b.app",
      expectedPostHogKeyHmacSha256: createHmac("sha256", "synthetic-key")
        .update("synthetic-project")
        .digest("hex"),
    },
  });
  jest.mocked(getPostHogBooleanFlagDecisionForUser).mockResolvedValue(true);
  jest.mocked(readConsent).mockResolvedValue(null);
  jest.mocked(readFailures).mockResolvedValue(target);
  jest.mocked(readCloudWorkspaceState).mockResolvedValue(null);
  jest.mocked(readE2BDiskRecoveryResult).mockResolvedValue(null);
  jest
    .mocked(getActiveTriggerRunsForUser)
    .mockResolvedValue({ runs: [], hasMore: false });
  jest
    .mocked(listActiveSubagentsForUser)
    .mockResolvedValue({ runs: [], hasMore: false });
  jest
    .mocked(getCurrentAgentEntitlementContext)
    .mockResolvedValue({ subscription: "pro" });
  exists.mockResolvedValue(0);
  jest.mocked(recoveryRedis).mockReturnValue({ exists } as never);
  jest.mocked(Sandbox.getInfo).mockResolvedValue(info as never);
  jest.mocked(Sandbox.list).mockReturnValue({
    hasNext: false,
    nextItems: async () => [info],
  } as never);
  jest.mocked(offerConsent).mockResolvedValue(consent);
  jest.mocked(decideConsent).mockResolvedValue(true);
  jest.mocked(failConsent).mockResolvedValue(undefined);
  jest.mocked(recoverE2BDiskOnly).mockResolvedValue({});
});
afterAll(() => {
  process.env = prior;
});
it("rechecks the confirmed organization's real paid-entitlement resolution before recovery", async () => {
  jest
    .mocked(readConsent)
    .mockResolvedValue({ ...consent, status: "confirmed" });
  jest.mocked(getCurrentAgentEntitlementContext).mockImplementation((input) =>
    resolveCurrentAgentEntitlementContext(input, {
      workos: {
        userManagement: {
          listOrganizationMemberships: async () => ({ data: [{}] }),
        },
        organizations: {
          getOrganization: async () => ({ stripeCustomerId: "cus-test" }),
        },
      },
      stripe: {
        subscriptions: {
          list: async () => ({
            has_more: false,
            data: [
              {
                id: "sub-test",
                status: "active",
                items: {
                  data: [{ price: { lookup_key: "pro-monthly-plan" } }],
                },
              },
            ],
          }),
        },
      },
    }),
  );
  await expect(
    executeCustomerRecovery("owner", token, "us-east-1"),
  ).resolves.toEqual({ status: "verified" });
  expect(getCurrentAgentEntitlementContext).toHaveBeenCalledWith({
    userId: "owner",
    organizationId: "org-owner",
  });
  expect(recoverE2BDiskOnly).toHaveBeenCalledTimes(1);
});
it("defaults off before inspecting any workspace", async () => {
  delete process.env.CLOUD_DISK_RECOVERY_TARGETS;
  expect(await recoveryView("owner")).toEqual({ status: "hidden" });
  expect(readFailures).not.toHaveBeenCalled();
});
it("does not confirm or execute recovery without an authenticated organization binding", async () => {
  jest.mocked(readConsent).mockResolvedValue(consent);
  await expect(confirmRecovery("owner", token, true)).rejects.toThrow();
  expect(decideConsent).not.toHaveBeenCalled();
  jest.mocked(readConsent).mockResolvedValue({
    ...consent,
    organizationId: undefined,
    status: "confirmed",
  });
  await expect(
    executeCustomerRecovery("owner", token, "us-east-1"),
  ).rejects.toThrow("support reconciliation");
  expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
});
it("a missing/disabled assignment never authorizes consent", async () => {
  jest.mocked(getPostHogBooleanFlagDecisionForUser).mockResolvedValue(null);
  await expect(
    confirmRecovery("owner", token, true, "org-owner"),
  ).rejects.toThrow();
  expect(decideConsent).not.toHaveBeenCalled();
});
it("one failed acquisition is a normal retry, not recovery", async () => {
  jest.mocked(readFailures).mockResolvedValue({ ...target, attempts: [token] });
  expect(await recoveryView("owner")).toEqual({ status: "hidden" });
  expect(Sandbox.getInfo).not.toHaveBeenCalled();
});
it("offers only after server-owned identity, idle and provider checks", async () => {
  expect(await recoveryView("owner")).toEqual({
    status: "offered",
    token,
    reference: "CR-7ad19af5",
  });
  expect(offerConsent).toHaveBeenCalledWith("owner", target);
  expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
});
describe.each([false, true])(
  "provider status reads with existing offer=%s",
  (existing) => {
    it.each([
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
      new RateLimitError("rate limited"),
      Object.assign(new SandboxError("unavailable"), { statusCode: 502 }),
    ])(
      "keeps temporary getInfo failure %s retryable without authorizing recovery",
      async (error) => {
        if (existing) jest.mocked(readConsent).mockResolvedValue(consent);
        jest.mocked(Sandbox.getInfo).mockRejectedValueOnce(error);
        expect(await recoveryView("owner")).toMatchObject({
          status: "waiting",
        });
        expect(offerConsent).not.toHaveBeenCalled();
        expect(decideConsent).not.toHaveBeenCalled();
        expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
        expect(await recoveryView("owner")).toMatchObject({
          status: "offered",
          token,
        });
      },
    );
    it("rechecks inventory after a temporary provider refusal", async () => {
      if (existing) jest.mocked(readConsent).mockResolvedValue(consent);
      jest.mocked(Sandbox.list).mockReturnValueOnce({
        hasNext: false,
        nextItems: async () => {
          throw new ServiceBusyError("busy");
        },
      } as never);
      expect(await recoveryView("owner")).toMatchObject({ status: "waiting" });
      expect(decideConsent).not.toHaveBeenCalled();
      expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
      expect(await recoveryView("owner")).toMatchObject({
        status: "offered",
        token,
      });
    });
  },
);
it.each([
  new AuthenticationError("invalid key"),
  new NotFoundError("sandbox absent"),
  new Error("unknown failure"),
])(
  "keeps definitive or unknown provider errors as support: %s",
  async (error) => {
    jest.mocked(readConsent).mockResolvedValue(consent);
    jest.mocked(Sandbox.getInfo).mockRejectedValueOnce(error);
    expect(await recoveryView("owner")).toMatchObject({ status: "support" });
    expect(decideConsent).not.toHaveBeenCalled();
    expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
  },
);
it.each([undefined])(
  "cannot recover an unverified autoResume=%s workspace",
  async (autoResume) => {
    jest.mocked(Sandbox.getInfo).mockResolvedValue({
      ...info,
      lifecycle: { ...info.lifecycle, autoResume },
    } as never);
    expect(await recoveryView("owner")).toEqual({
      status: "support",
      reference: "CR-7ad19af5",
    });
    expect(offerConsent).not.toHaveBeenCalled();
  },
);
it.each([
  "owner",
  "region",
  "state",
  "hold",
  "inventory",
  "lease",
  "active",
  "child",
  "unknown",
  "migration",
  "cleanup",
  "uncertain",
  "runtime",
])("denies unsafe eligibility: %s", async (reason) => {
  if (reason === "owner")
    jest.mocked(Sandbox.getInfo).mockResolvedValue({
      ...info,
      metadata: { ...info.metadata, userID: "other" },
    } as never);
  if (reason === "region")
    jest.mocked(Sandbox.getInfo).mockResolvedValue({
      ...info,
      metadata: { ...info.metadata, e2bCluster: "eu" },
    } as never);
  if (reason === "state")
    jest
      .mocked(Sandbox.getInfo)
      .mockResolvedValue({ ...info, state: "running" } as never);
  if (reason === "hold")
    jest.mocked(Sandbox.getInfo).mockResolvedValue({
      ...info,
      metadata: { ...info.metadata, preservationHold: "true" },
    } as never);
  if (reason === "inventory")
    jest.mocked(Sandbox.list).mockReturnValue({
      hasNext: false,
      nextItems: async () => [info, { ...info, sandboxId: "other" }],
    } as never);
  if (reason === "lease") exists.mockResolvedValue(1);
  if (reason === "active")
    jest.mocked(getActiveTriggerRunsForUser).mockResolvedValue({
      runs: [{ chatId: "chat", triggerRunId: "run" }],
      hasMore: false,
    });
  if (reason === "child")
    jest
      .mocked(listActiveSubagentsForUser)
      .mockResolvedValue({ runs: [{}] as never, hasMore: false });
  if (reason === "unknown")
    jest
      .mocked(getActiveTriggerRunsForUser)
      .mockResolvedValue({ runs: [], hasMore: true });
  if (["migration", "cleanup"].includes(reason))
    jest
      .mocked(readCloudWorkspaceState)
      .mockResolvedValue({ phase: reason } as never);
  if (reason === "uncertain")
    jest.mocked(readFailures).mockResolvedValue({ ...target, uncertain: true });
  if (reason === "runtime")
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://wrong.convex.cloud";
  expect(await recoveryView("owner")).toEqual({
    reference: "CR-7ad19af5",
    status: ["lease", "active", "child", "unknown"].includes(reason)
      ? "waiting"
      : "support",
  });
  expect(offerConsent).not.toHaveBeenCalled();
  expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
});
it("rejects consent from another owner or a modified/expired receipt", async () => {
  await expect(
    confirmRecovery("other", token, true, "org-owner"),
  ).rejects.toThrow();
  jest.mocked(readConsent).mockResolvedValue(consent);
  await expect(
    confirmRecovery("owner", "other-token", true, "org-owner"),
  ).rejects.toThrow();
  jest
    .mocked(readConsent)
    .mockResolvedValue({ ...consent, issuedAt: Date.now() - 660000 });
  await expect(
    confirmRecovery("owner", token, true, "org-owner"),
  ).rejects.toThrow();
  expect(decideConsent).not.toHaveBeenCalled();
});
it("declining cannot invoke recovery and survives later reads", async () => {
  jest.mocked(readConsent).mockResolvedValue(consent);
  expect(await confirmRecovery("owner", token, false)).toBeNull();
  expect(decideConsent).toHaveBeenCalledWith(
    "owner",
    consent,
    false,
    undefined,
  );
  jest
    .mocked(readConsent)
    .mockResolvedValue({ ...consent, status: "declined" });
  expect(await recoveryView("owner")).toEqual({
    status: "declined",
    token,
    reference: "CR-7ad19af5",
  });
  expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
});
it("only one concurrent confirmation dispatches work", async () => {
  jest.mocked(readConsent).mockResolvedValue(consent);
  jest
    .mocked(decideConsent)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  const results = await Promise.all([
    confirmRecovery("owner", token, true, "org-owner"),
    confirmRecovery("owner", token, true, "org-owner"),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
});
it("rechecks eligibility before execution and consumes only confirmed consent", async () => {
  jest.mocked(readConsent).mockResolvedValue(consent);
  await expect(
    executeCustomerRecovery("owner", token, "us-east-1"),
  ).rejects.toThrow();
  expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
  jest
    .mocked(readConsent)
    .mockResolvedValue({ ...consent, status: "confirmed" });
  await expect(
    executeCustomerRecovery("owner", token, "eu-central-1"),
  ).rejects.toThrow();
  await expect(
    executeCustomerRecovery("owner", token, "us-east-1"),
  ).resolves.toEqual({ status: "verified" });
  expect(recoverE2BDiskOnly).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: "owner",
      sandboxId: "synthetic",
      idempotencyKey: token,
    }),
    expect.objectContaining({ consentKey: "cloud_recovery_consent:v1:owner" }),
  );
});
it("marks failed provider work support-only without a second attempt", async () => {
  jest
    .mocked(readConsent)
    .mockResolvedValue({ ...consent, status: "confirmed" });
  jest.mocked(recoverE2BDiskOnly).mockRejectedValueOnce(new Error("timeout"));
  await expect(
    executeCustomerRecovery("owner", token, "us-east-1"),
  ).rejects.toThrow("support reconciliation");
  expect(failConsent).toHaveBeenCalledWith("owner", token);
  jest.mocked(readConsent).mockResolvedValue({ ...consent, status: "failed" });
  expect(await recoveryView("owner")).toEqual({
    status: "support",
    reference: "CR-7ad19af5",
  });
  await expect(
    executeCustomerRecovery("owner", token, "us-east-1"),
  ).rejects.toThrow();
  expect(recoverE2BDiskOnly).toHaveBeenCalledTimes(1);
});
it("a completion receipt must match the exact sandbox and region", async () => {
  jest
    .mocked(readConsent)
    .mockResolvedValue({ ...consent, status: "executing" });
  jest.mocked(readE2BDiskRecoveryResult).mockResolvedValue({
    token,
    status: "verified_ready",
    completedAt: new Date().toISOString(),
    sandboxId: "other",
    region: target.region,
  });
  expect((await recoveryView("owner")).status).toBe("recovering");
  jest.mocked(readE2BDiskRecoveryResult).mockResolvedValue({
    token,
    status: "verified_ready",
    completedAt: new Date().toISOString(),
    sandboxId: target.sandboxId,
    region: target.region,
  });
  jest.mocked(readCloudWorkspaceState).mockResolvedValue({
    version: 1,
    phase: "e2b",
    token,
    sourceId: target.sandboxId,
    destinationId: target.sandboxId,
    region: target.region,
  });
  expect(await recoveryView("owner")).toEqual({
    status: "recovered",
    reference: "CR-7ad19af5",
  });
});
it("an interrupted task becomes support-only while keeping its receipt", async () => {
  jest.mocked(readConsent).mockResolvedValue({
    ...consent,
    status: "confirmed",
    issuedAt: Date.now() - 26 * 60000,
  });
  expect((await recoveryView("owner")).status).toBe("support");
  expect(decideConsent).not.toHaveBeenCalled();
});

it("does not execute stale queued consent", async () => {
  jest.mocked(readConsent).mockResolvedValue({
    ...consent,
    status: "confirmed",
    issuedAt: Date.now() - 11 * 60000,
  });
  await expect(
    executeCustomerRecovery("owner", token, "us-east-1"),
  ).rejects.toThrow();
  expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
  expect(failConsent).toHaveBeenCalledWith("owner", token);
});
it.each(["E2B_API_URL", "E2B_SANDBOX_URL", "E2B_DOMAIN", "E2B_DEBUG"])(
  "refuses an unverified provider override: %s",
  async (name) => {
    process.env[name] =
      name === "E2B_DEBUG" ? "true" : "https://unverified.example.test";
    expect(await recoveryView("owner")).toEqual({
      status: "support",
      reference: "CR-7ad19af5",
    });
    expect(Sandbox.getInfo).not.toHaveBeenCalled();
  },
);
it("a completed receipt cannot hide a newer durable recovery fence", async () => {
  jest
    .mocked(readConsent)
    .mockResolvedValue({ ...consent, status: "executing" });
  jest.mocked(readE2BDiskRecoveryResult).mockResolvedValue({
    token,
    status: "verified_ready",
    completedAt: new Date().toISOString(),
    sandboxId: target.sandboxId,
    region: target.region,
  });
  jest.mocked(readCloudWorkspaceState).mockResolvedValue({
    phase: "recovery",
    token: "other-recovery",
    step: "support_required",
    startedAt: new Date().toISOString(),
  } as never);
  expect((await recoveryView("owner")).status).toBe("support");
});

it("refuses unrecognized workspace preservation fields", async () => {
  jest.mocked(readCloudWorkspaceState).mockResolvedValue({
    version: 1,
    phase: "e2b",
    token,
    sourceId: target.sandboxId,
    destinationId: target.sandboxId,
    region: target.region,
    preservationHold: "pending",
  } as never);
  expect(await recoveryView("owner")).toEqual({
    status: "support",
    reference: "CR-7ad19af5",
  });
  expect(offerConsent).not.toHaveBeenCalled();
});

it("a newer failure supersedes a verified receipt without allowing another reboot", async () => {
  jest
    .mocked(readConsent)
    .mockResolvedValue({ ...consent, status: "executing" });
  jest.mocked(readCloudWorkspaceState).mockResolvedValue({
    version: 1,
    phase: "e2b",
    token,
    sourceId: target.sandboxId,
    destinationId: target.sandboxId,
    region: target.region,
  });
  jest.mocked(readE2BDiskRecoveryResult).mockResolvedValue({
    token,
    status: "verified_ready",
    sandboxId: target.sandboxId,
    region: target.region,
    completedAt: new Date(Date.now() - 60000).toISOString(),
  });
  jest
    .mocked(readFailures)
    .mockResolvedValue({ ...target, lastFailedAt: Date.now() });
  expect(await recoveryView("owner")).toEqual({
    status: "support",
    reference: "CR-7ad19af5",
  });
  expect(offerConsent).not.toHaveBeenCalled();
});
it("allows a timely confirmed consent even when the original offer is old", async () => {
  jest.mocked(readConsent).mockResolvedValue({
    ...consent,
    status: "confirmed",
    issuedAt: Date.now() - 13 * 60000,
    confirmedAt: Date.now() - 4 * 60000,
  });
  await expect(
    executeCustomerRecovery("owner", token, target.region),
  ).resolves.toEqual({ status: "verified" });
});
it("refuses a stale confirmation timestamp", async () => {
  jest.mocked(readConsent).mockResolvedValue({
    ...consent,
    status: "confirmed",
    issuedAt: Date.now() - 15 * 60000,
    confirmedAt: Date.now() - 11 * 60000,
  });
  await expect(
    executeCustomerRecovery("owner", token, target.region),
  ).rejects.toThrow();
  expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
});

it("permits a known auto-resume lifecycle with every other guard intact", async () => {
  jest.mocked(Sandbox.getInfo).mockResolvedValue({
    ...info,
    lifecycle: { autoResume: true, onTimeout: "pause" },
  } as never);
  expect(await recoveryView("owner")).toMatchObject({
    status: "offered",
    token,
  });
  expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
});
it("reopening deferred consent only renews an unconsumed receipt", async () => {
  jest
    .mocked(readConsent)
    .mockResolvedValue({ ...consent, status: "declined" });
  await reopenRecovery("owner", token);
  expect(renewConsent).toHaveBeenCalledWith(
    "owner",
    expect.objectContaining({ token, status: "declined" }),
  );
  for (const status of ["confirmed", "executing", "failed"] as const) {
    jest.mocked(readConsent).mockResolvedValue({ ...consent, status });
    await expect(reopenRecovery("owner", token)).rejects.toThrow();
  }
  expect(renewConsent).toHaveBeenCalledTimes(1);
  expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
});
it("refreshes an expired unconsumed offer instead of sending it permanently to support", async () => {
  jest
    .mocked(readConsent)
    .mockResolvedValue({ ...consent, issuedAt: Date.now() - 11 * 60000 });
  jest.mocked(renewConsent).mockResolvedValue(consent);
  expect(await recoveryView("owner")).toMatchObject({
    status: "offered",
    token,
  });
  expect(decideConsent).not.toHaveBeenCalled();
});

it("waits for the complete idle window before reconciling known resume deadlines", async () => {
  const failure = { ...target, uncertain: true, timeoutOnly: true };
  jest.mocked(readFailures).mockResolvedValue(failure);
  expect(await recoveryView("owner")).toMatchObject({ status: "waiting" });
  expect(Sandbox.getInfo).not.toHaveBeenCalled();
  jest
    .mocked(readFailures)
    .mockResolvedValue({ ...failure, lastFailedAt: Date.now() - 16 * 60000 });
  expect(await recoveryView("owner")).toMatchObject({ status: "offered" });
  jest
    .mocked(Sandbox.getInfo)
    .mockResolvedValue({ ...info, state: "running" } as never);
  expect(await recoveryView("owner")).toMatchObject({ status: "support" });
  expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
});
it("never treats an unknown old outcome as a reconciled deadline", async () => {
  jest.mocked(readFailures).mockResolvedValue({
    ...target,
    uncertain: true,
    timeoutOnly: false,
    lastFailedAt: Date.now() - 16 * 60000,
  });
  expect(await recoveryView("owner")).toMatchObject({ status: "support" });
  expect(Sandbox.getInfo).not.toHaveBeenCalled();
});

it("rollout rollback hides new offers but preserves support for consumed consent", async () => {
  jest.mocked(getPostHogBooleanFlagDecisionForUser).mockResolvedValue(false);
  jest.mocked(readConsent).mockResolvedValue(consent);
  expect(await recoveryView("owner")).toEqual({ status: "hidden" });
  jest
    .mocked(readConsent)
    .mockResolvedValue({ ...consent, status: "executing" });
  expect(await recoveryView("owner")).toEqual({
    status: "support",
    reference: "CR-7ad19af5",
  });
  await expect(
    confirmRecovery("owner", token, true, "org-owner"),
  ).rejects.toThrow();
  expect(Sandbox.getInfo).not.toHaveBeenCalled();
  expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
});
it("removes the deferred card when ordinary reconnection already resolved the incident", async () => {
  jest
    .mocked(readConsent)
    .mockResolvedValue({ ...consent, status: "declined" });
  jest.mocked(readFailures).mockResolvedValue(null);
  expect(await recoveryView("owner")).toEqual({ status: "hidden" });
  expect(renewConsent).not.toHaveBeenCalled();
});

it.each(["offered", "declined"] as const)(
  "rebinds an unconsumed %s receipt when a new workspace has its own eligible incident",
  async (status) => {
    const nextTarget = { ...target, sandboxId: "next-workspace" };
    const nextToken = "2ad19af5-4d14-4d4b-aab7-90734610a6da";
    const oldConsent = { ...consent, status };
    jest.mocked(readConsent).mockResolvedValue(oldConsent);
    jest.mocked(readFailures).mockResolvedValue(nextTarget);
    jest.mocked(renewConsent).mockResolvedValue({
      ...consent,
      token: nextToken,
      target: nextTarget,
    });
    const nextInfo = { ...info, sandboxId: nextTarget.sandboxId };
    jest.mocked(Sandbox.getInfo).mockResolvedValue(nextInfo as never);
    jest.mocked(Sandbox.list).mockReturnValue({
      hasNext: false,
      nextItems: async () => [nextInfo],
    } as never);
    expect(await recoveryView("owner")).toMatchObject({
      status: "offered",
      token: nextToken,
    });
    expect(renewConsent).toHaveBeenCalledWith("owner", oldConsent, nextTarget);
    expect(decideConsent).not.toHaveBeenCalled();
    expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
  },
);
it.each(["confirmed", "executing", "failed"] as const)(
  "never rebinds a consumed %s receipt to a later workspace",
  async (status) => {
    jest.mocked(readConsent).mockResolvedValue({ ...consent, status });
    jest
      .mocked(readFailures)
      .mockResolvedValue({ ...target, sandboxId: "next-workspace" });
    expect((await recoveryView("owner")).status).toBe(
      status === "failed" ? "support" : "recovering",
    );
    expect(renewConsent).not.toHaveBeenCalled();
    expect(recoverE2BDiskOnly).not.toHaveBeenCalled();
  },
);
