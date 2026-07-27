import { phLogger } from "@/lib/posthog/server";
import type {
  ChatMode,
  SandboxResourceMetricsObserver,
  SubscriptionTier,
} from "@/types";

export const E2B_CPU_SATURATION_THRESHOLD_PCT = 99;

const roundPercentage = (value: number): number =>
  Math.round(value * 100) / 100;

/**
 * Tracks rising edges into CPU saturation for one chat request.
 *
 * A sustained period at or above the threshold emits once. A later observation
 * below the threshold rearms the tracker so a new saturation episode can emit.
 */
export function createE2BCpuSaturationObserver(args: {
  userId: string;
  chatId: string;
  mode: ChatMode;
  subscription?: SubscriptionTier;
}): SandboxResourceMetricsObserver {
  let cpuWasSaturated = false;

  return ({ cpuPct, memPct, diskPct }) => {
    const cpuIsSaturated =
      Number.isFinite(cpuPct) && cpuPct >= E2B_CPU_SATURATION_THRESHOLD_PCT;

    if (!cpuIsSaturated) {
      cpuWasSaturated = false;
      return;
    }

    if (cpuWasSaturated) return;
    cpuWasSaturated = true;

    phLogger.event("e2b_sandbox_cpu_saturation_observed", {
      userId: args.userId,
      chat_id: args.chatId,
      mode: args.mode,
      subscription_tier: args.subscription ?? "unknown",
      sandbox_type: "e2b",
      cpu_used_pct: roundPercentage(cpuPct),
      memory_used_pct: roundPercentage(memPct),
      disk_used_pct: roundPercentage(diskPct),
      cpu_saturation_threshold_pct: E2B_CPU_SATURATION_THRESHOLD_PCT,
      observation_source: "pre_command_health_check",
      cpu_saturation_event_version: 1,
    });
  };
}
