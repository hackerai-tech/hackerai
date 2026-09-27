import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  miosaAcquisitionFailureDiagnostics,
  miosaErrorDiagnostics,
} from "./miosa-acquisition-diagnostics";

const COOLDOWN_SECONDS = 120;
const keyFor = (userId: string) => `miosa_acquisition_cooldown:v1:${userId}`;

export class MiosaAcquisitionCooldownError extends Error {
  readonly code = "ACQUISITION_COOLDOWN";
  constructor() {
    super(
      "Cloud workspace temporarily unavailable. Please retry in a few minutes. Your files are preserved.",
    );
    this.name = "MiosaAcquisitionCooldownError";
  }
}

/** Only known terminal workspaces and missing snapshots merit a bounded skip. */
export async function rememberTerminalMiosaFailure(
  userId: string,
  error: unknown,
): Promise<void> {
  const provider = miosaErrorDiagnostics(error);
  const acquisition = miosaAcquisitionFailureDiagnostics(error);
  if (
    provider.error_code !== "SNAPSHOT_MISSING" &&
    !["error", "destroying", "destroyed"].includes(
      acquisition.sandbox_state ?? provider.sandbox_state ?? "",
    )
  )
    return;
  try {
    await createRedisClient()?.set(keyFor(userId), "1", {
      ex: COOLDOWN_SECONDS,
    });
  } catch {
    // A failed cache write must not hide the original acquisition error.
  }
}

export async function assertMiosaAcquisitionNotCoolingDown(
  userId: string,
): Promise<void> {
  try {
    if (await createRedisClient()?.get(keyFor(userId))) {
      throw new MiosaAcquisitionCooldownError();
    }
  } catch (error) {
    if (error instanceof MiosaAcquisitionCooldownError) throw error;
    // A failed cooldown read permits the normal bounded provider acquisition.
  }
}
