import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";
import {
  decideConsent,
  recordResumeFailure,
  renewConsent,
  reconcileLegacyPreflightFailure,
} from "../store";
jest.mock("@/lib/posthog/server", () => ({
  getPostHogBooleanFlagDecisionForUser: jest.fn(),
}));
const mockEval = jest.fn();
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => ({ eval: mockEval }),
}));
const token = "7ad19af5-4d14-4d4b-aab7-90734610a6da";
const target = {
  sandboxId: "synthetic",
  region: "us-east-1" as const,
  template: "template",
  sandboxVersion: "v12",
  attempts: [token],
  uncertain: false,
  lastFailedAt: Date.now(),
};
const previous = process.env.CLOUD_DISK_RECOVERY_TARGETS;
beforeEach(() => {
  jest.resetAllMocks();
  process.env.CLOUD_DISK_RECOVERY_TARGETS = "configured";
  mockEval.mockResolvedValue(1);
});
afterAll(() => {
  if (previous === undefined) delete process.env.CLOUD_DISK_RECOVERY_TARGETS;
  else process.env.CLOUD_DISK_RECOVERY_TARGETS = previous;
});
it.each([false, null])(
  "does not persist new records outside the per-user rollout: %s",
  async (enabled) => {
    jest
      .mocked(getPostHogBooleanFlagDecisionForUser)
      .mockResolvedValue(enabled);
    await recordResumeFailure({
      userId: "owner",
      ...target,
      acquisitionId: token,
    });
    expect(mockEval).not.toHaveBeenCalled();
  },
);
it("records the confirmation timestamp, and no confirmation timestamp for decline", async () => {
  const consent = {
    token,
    target,
    status: "offered" as const,
    issuedAt: Date.now() - 9 * 60000,
  };
  const before = Date.now();
  await decideConsent("owner", consent, true, "session-org");
  const saved = JSON.parse(mockEval.mock.calls[0][2][1]);
  expect(saved.confirmedAt).toBeGreaterThanOrEqual(before);
  expect(saved.issuedAt).toBe(consent.issuedAt);
  expect(saved.organizationId).toBe("session-org");
  await decideConsent("owner", consent, false);
  expect(JSON.parse(mockEval.mock.calls[1][2][1]).confirmedAt).toBeUndefined();
});

it("persists the new server-selected target when an unconsumed warning is rebound", async () => {
  const consent = {
    token,
    target,
    status: "declined" as const,
    issuedAt: Date.now() - 60000,
  };
  const nextTarget = { ...target, sandboxId: "next-workspace" };
  await renewConsent("owner", consent, nextTarget);
  const saved = JSON.parse(mockEval.mock.calls[0][2][1]);
  expect(saved).toMatchObject({ target: nextTarget, status: "offered" });
});

it.each([
  { taskTerminal: false, providerConfirmedNoReboot: true, reference: "review" },
  { taskTerminal: true, providerConfirmedNoReboot: false, reference: "review" },
  { taskTerminal: true, providerConfirmedNoReboot: true, reference: "" },
])(
  "refuses legacy reconciliation without complete evidence: %j",
  async (evidence) => {
    await expect(
      reconcileLegacyPreflightFailure(
        "owner",
        JSON.stringify({
          token,
          target,
          status: "failed",
          issuedAt: Date.now(),
        }),
        evidence,
      ),
    ).rejects.toThrow("independent pre-reboot evidence");
    expect(mockEval).not.toHaveBeenCalled();
  },
);
