import {
  Sandbox,
  type SandboxInfo,
  type SandboxApiOpts,
} from "@e2b/code-interpreter";

/** Control-plane reads only: never resume a paused sandbox to collect metrics. */
export async function readE2BRuntimeDiagnostics(
  info: SandboxInfo,
  options: SandboxApiOpts,
) {
  const end = new Date();
  const start = new Date(end.getTime() - 5 * 60_000);
  const metrics = await Sandbox.getMetrics(info.sandboxId, {
    ...options,
    start,
    end,
    retries: 0,
    requestTimeoutMs: 2_000,
  }).catch(() => []);
  const latest = metrics
    .filter((item) => item.timestamp >= start && item.timestamp <= end)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
  const finite = (value: number) =>
    Number.isFinite(value) && value >= 0 ? value : null;
  return {
    envdVersion: /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,64})?$/.test(
      info.envdVersion,
    )
      ? info.envdVersion
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
