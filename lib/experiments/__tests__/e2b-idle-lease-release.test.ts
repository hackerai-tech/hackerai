import {
  BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
  E2B_SANDBOX_IDLE_RELEASE_TIMEOUT_MS,
} from "@/lib/ai/tools/utils/e2b-lease";
import { E2B_COST_PER_MS } from "@/lib/ai/tools/utils/e2b-cost";
import {
  E2B_IDLE_LEASE_RELEASE_FLAG_KEY,
  finalizeE2BIdleLeaseRelease,
} from "../e2b-idle-lease-release";

jest.mock("@/lib/posthog/server", () => ({
  getPostHogFeatureFlagValueForUser: jest.fn(),
  phLogger: {
    event: jest.fn(),
    warn: jest.fn(),
  },
}));

const baseArgs = () => ({
  userId: "user-1",
  chatId: "chat-1",
  triggerRunId: "run-1",
  triggerRegion: "eu-central-1",
  subscription: "pro",
  e2bRuntimeMs: 30_000,
});

describe("E2B idle lease release experiment", () => {
  it("does not evaluate or release for runs that never used E2B", async () => {
    const evaluateFlag = jest.fn(async () => true);
    const releaseLease = jest.fn(async () => true);
    const captureExposure = jest.fn();

    await expect(
      finalizeE2BIdleLeaseRelease({
        ...baseArgs(),
        e2bRuntimeMs: 0,
        evaluateFlag,
        releaseLease,
        captureExposure,
      }),
    ).resolves.toBe("not_eligible");

    expect(evaluateFlag).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
    expect(captureExposure).not.toHaveBeenCalled();
  });

  it("records an eligible control without changing its lease", async () => {
    const evaluateFlag = jest.fn(async () => false);
    const releaseLease = jest.fn(async () => true);
    const captureExposure = jest.fn();

    await expect(
      finalizeE2BIdleLeaseRelease({
        ...baseArgs(),
        evaluateFlag,
        releaseLease,
        captureExposure,
      }),
    ).resolves.toBe("control");

    expect(evaluateFlag).toHaveBeenCalledWith(
      E2B_IDLE_LEASE_RELEASE_FLAG_KEY,
      "user-1",
    );
    expect(releaseLease).not.toHaveBeenCalled();
    expect(captureExposure).toHaveBeenCalledWith(
      "e2b_idle_lease_release_exposure",
      expect.objectContaining({
        assignment: "control",
        feature_flag_enabled: false,
        release_outcome: "control",
        estimated_max_cost_savings_usd: 0,
      }),
    );
  });

  it("releases the treatment lease and records its maximum estimated saving", async () => {
    const evaluateFlag = jest.fn(async () => true);
    const releaseLease = jest.fn(async () => true);
    const captureExposure = jest.fn();

    await expect(
      finalizeE2BIdleLeaseRelease({
        ...baseArgs(),
        evaluateFlag,
        releaseLease,
        captureExposure,
      }),
    ).resolves.toBe("released");

    const potentialSavingsMs =
      BASH_SANDBOX_AUTOPAUSE_TIMEOUT - E2B_SANDBOX_IDLE_RELEASE_TIMEOUT_MS;
    expect(releaseLease).toHaveBeenCalledTimes(1);
    expect(captureExposure).toHaveBeenCalledWith(
      "e2b_idle_lease_release_exposure",
      expect.objectContaining({
        assignment: "treatment",
        feature_flag_enabled: true,
        release_outcome: "released",
        potential_idle_savings_ms: potentialSavingsMs,
        estimated_max_cost_savings_usd: potentialSavingsMs * E2B_COST_PER_MS,
      }),
    );
  });

  it("records a treatment failure without breaking Trigger cleanup", async () => {
    const captureExposure = jest.fn();

    await expect(
      finalizeE2BIdleLeaseRelease({
        ...baseArgs(),
        evaluateFlag: jest.fn(async () => true),
        releaseLease: jest.fn(async () => false),
        captureExposure,
      }),
    ).resolves.toBe("release_failed");

    expect(captureExposure).toHaveBeenCalledWith(
      "e2b_idle_lease_release_exposure",
      expect.objectContaining({
        release_outcome: "release_failed",
        estimated_max_cost_savings_usd: 0,
      }),
    );
  });

  it("fails closed when the flag cannot be evaluated", async () => {
    const releaseLease = jest.fn(async () => true);
    const captureExposure = jest.fn();

    await expect(
      finalizeE2BIdleLeaseRelease({
        ...baseArgs(),
        evaluateFlag: jest.fn(async () => null),
        releaseLease,
        captureExposure,
      }),
    ).resolves.toBe("flag_unavailable");

    expect(releaseLease).not.toHaveBeenCalled();
    expect(captureExposure).not.toHaveBeenCalled();
  });
});
