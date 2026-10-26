import {
  Sandbox,
  type SandboxInfo,
  type SandboxApiOpts,
} from "@e2b/code-interpreter";

const VERSION =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[a-zA-Z0-9.-]{1,64})?$/;

/** Null means the version cannot establish this capability, not that it lacks it. */
export function envdVersionAtLeast(
  value: unknown,
  minimum: [number, number, number],
): boolean | null {
  const match = typeof value === "string" ? VERSION.exec(value) : null;
  const parts = match?.slice(1, 4).map(Number);
  if (!parts || !parts.every(Number.isSafeInteger)) return null;
  for (let index = 0; index < 3; index++) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return true;
}

const observedVersion = (value: unknown): string | null =>
  typeof value === "string" &&
  value.length <= 100 &&
  /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,64})?$/.test(value)
    ? value
    : null;

/** Never wake a paused sandbox for diagnostics. Runtime checks need an already connected instance. */
export async function readE2BRuntimeDiagnostics(
  info: SandboxInfo,
  options: SandboxApiOpts,
  connected?: Pick<Sandbox, "sandboxId" | "commands">,
) {
  const end = new Date();
  const start = new Date(end.getTime() - 5 * 60_000);
  const metricsRequest = Sandbox.getMetrics(info.sandboxId, {
    ...options,
    start,
    end,
    retries: 0,
    requestTimeoutMs: 2_000,
  }).catch(() => []);
  let runtimeEnvdVersion: string | null = null;
  let runtimeVersionCheck:
    "not_checked_paused" | "not_checked" | "unavailable" | "observed" =
    info.state === "paused" ? "not_checked_paused" : "not_checked";
  if (info.state === "running" && connected?.sandboxId === info.sandboxId) {
    runtimeVersionCheck = "unavailable";
    const command = await connected.commands
      .run("/usr/bin/envd -version", {
        timeoutMs: 2_000,
        requestTimeoutMs: 2_000,
      })
      .catch(() => null);
    if (command?.exitCode === 0 && typeof command.stdout === "string") {
      runtimeEnvdVersion = observedVersion(command.stdout.trim());
      if (runtimeEnvdVersion) runtimeVersionCheck = "observed";
    }
  }
  const metrics = await metricsRequest;
  const latest = metrics
    .filter((item) => item.timestamp >= start && item.timestamp <= end)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
  const finite = (value: number) =>
    Number.isFinite(value) && value >= 0 ? value : null;
  return {
    templateBuildEnvdVersion: observedVersion(info.envdVersion),
    runtimeEnvdVersion,
    runtimeVersionCheck,
    // Meeting the binary minimum does not prove E2B has enabled its rollout.
    runtimeMeetsReadinessMinimum: envdVersionAtLeast(
      runtimeEnvdVersion,
      [0, 10, 0],
    ),
    readinessSafeguardRollout: "unknown" as const,
    onTimeout:
      info.lifecycle?.onTimeout === "pause"
        ? "pause"
        : info.lifecycle?.onTimeout === "kill"
          ? "kill"
          : "unknown",
    expiresAt:
      info.endAt instanceof Date && Number.isFinite(info.endAt.getTime())
        ? info.endAt.toISOString()
        : null,
    cpuCount: finite(info.cpuCount),
    memoryMB: finite(info.memoryMB),
    metrics: latest
      ? {
          timestamp: latest.timestamp.toISOString(),
          cpuUsedPct: finite(latest.cpuUsedPct),
          memoryUsedBytes: finite(latest.memUsed),
          memoryTotalBytes: finite(latest.memTotal),
          diskUsedBytes: finite(latest.diskUsed),
          diskTotalBytes: finite(latest.diskTotal),
        }
      : null,
  };
}
