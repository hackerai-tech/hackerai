import type { AnySandbox } from "@/types";
import { isE2BSandbox } from "@/lib/ai/tools/utils/sandbox-types";
import { runAttachmentCommand } from "@/lib/ai/tools/utils/attachment-command";

/** One read-only probe per batch, including after reconnecting the SDK client. */
export async function checkAttachmentReadiness(
  sandbox: AnySandbox,
  signal?: AbortSignal,
) {
  if (!isE2BSandbox(sandbox)) return;
  signal?.throwIfAborted();
  const result = await runAttachmentCommand(sandbox, "true", signal, {
    timeoutMs: 5_000,
    requestTimeoutMs: 5_000,
  });
  signal?.throwIfAborted();
  if (result.exitCode !== 0)
    throw new Error("Sandbox attachment readiness command failed");
}

/** Control-plane metrics still work when the guest cannot start a command. */
export async function sampleAttachmentFailureMetrics(
  sandbox: AnySandbox,
): Promise<Record<string, string | number>> {
  if (!isE2BSandbox(sandbox)) return { metrics_status: "not_e2b" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const metrics = await Promise.race([
      sandbox.getMetrics({ requestTimeoutMs: 1_000 }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1_000);
      }),
    ]);
    const latest = metrics?.at(-1);
    if (!latest) return { metrics_status: "unavailable" };
    const fields = {
      cpu_used_pct: latest.cpuUsedPct,
      memory_used_bytes: latest.memUsed,
      memory_total_bytes: latest.memTotal,
      disk_used_bytes: latest.diskUsed,
      disk_total_bytes: latest.diskTotal,
    };
    return {
      metrics_status: "available",
      ...Object.fromEntries(
        Object.entries(fields).filter(
          ([, value]) =>
            typeof value === "number" && Number.isFinite(value) && value >= 0,
        ),
      ),
    };
  } catch {
    return { metrics_status: "unavailable" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
