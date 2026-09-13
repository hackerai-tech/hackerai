import { assertTriggerRunRegion } from "@/lib/api/trigger-region";

/** Fail the reservation without loading task content in the wrong region. */
export async function assertSubagentRunRegion(
  options: Parameters<typeof assertTriggerRunRegion>[0],
  finalizeFailure: (failure: {
    status: "failed";
    summary: string;
    failureCode: string;
  }) => Promise<unknown>,
): Promise<void> {
  try {
    assertTriggerRunRegion(options);
  } catch (error) {
    await finalizeFailure({
      status: "failed",
      summary: "Subagent failed region validation before starting.",
      failureCode: "region_mismatch",
    }).catch(() => undefined);
    // Preserve the placement failure even if the control-plane write fails.
    // The existing queued-reservation watchdog remains the last-resort cleanup.
    throw error;
  }
}
