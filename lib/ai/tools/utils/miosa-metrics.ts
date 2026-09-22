/**
 * MIOSA sandbox resource metrics.
 *
 * MIOSA's `GET /api/v1/sandboxes/:id/metrics` currently reports the sandbox's
 * *configured* shape (cpu_count / memory_mb / disk_size_mb) and an empty time
 * series — it does not yet publish live utilisation. Wiring the health check to
 * it would return numbers that never move, which is worse than none: the agent
 * would read "0% CPU" while the box is pegged.
 *
 * So sample the guest directly instead. One short exec reads /proc and df, and
 * the CPU figure comes from two /proc/stat snapshots 200ms apart, because a
 * single snapshot only gives cumulative jiffies since boot, not current load.
 *
 * Swap this for the API once MIOSA publishes a real series.
 */

import type { SandboxResourceMetrics } from "@/types";
import type { MiosaSandbox } from "./miosa-sandbox";

/** Gap between the two /proc/stat reads used to derive CPU utilisation. */
const CPU_SAMPLE_INTERVAL_MS = 200;

/** Keep the probe well under any caller timeout — metrics must never block a command. */
const PROBE_TIMEOUT_MS = 5_000;

const PROBE = `
a=$(head -n1 /proc/stat)
sleep ${CPU_SAMPLE_INTERVAL_MS / 1000}
b=$(head -n1 /proc/stat)
echo "CPU_A:$a"
echo "CPU_B:$b"
echo "MEM_TOTAL:$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"
echo "MEM_AVAIL:$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)"
df -k / | awk 'NR==2{print "DISK_USED:"$3; print "DISK_TOTAL:"($3+$4)}'
`.trim();

function field(lines: string[], prefix: string): string | null {
  const hit = lines.find((l) => l.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

/**
 * CPU utilisation between two `/proc/stat` cpu lines.
 *
 * Field 4 is idle and field 5 is iowait; everything else counts as busy.
 * Returns 0 when the two samples are identical (an idle box), never NaN.
 */
function cpuPctFromStat(a: string, b: string): number {
  const parse = (line: string): number[] =>
    line
      .replace(/^cpu\s+/, "")
      .trim()
      .split(/\s+/)
      .map((n) => Number.parseInt(n, 10) || 0);

  const first = parse(a);
  const second = parse(b);
  if (first.length < 5 || second.length < 5) return 0;

  const totalOf = (v: number[]) => v.reduce((sum, n) => sum + n, 0);
  const idleOf = (v: number[]) => (v[3] ?? 0) + (v[4] ?? 0);

  const totalDelta = totalOf(second) - totalOf(first);
  const idleDelta = idleOf(second) - idleOf(first);
  if (totalDelta <= 0) return 0;

  const pct = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.min(100, Math.max(0, pct));
}

/**
 * Sample live CPU, memory and disk usage from inside a MIOSA sandbox.
 *
 * Returns `null` — never throws — when the probe fails or the guest returns
 * something unparseable. A metrics failure must not fail the health check that
 * called it, let alone the command behind it.
 */
export async function sampleMiosaMetrics(
  sandbox: MiosaSandbox,
): Promise<SandboxResourceMetrics | null> {
  try {
    const result = await sandbox.commands.run(PROBE, {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return null;

    const lines = result.stdout.split("\n").map((l) => l.trim());

    const cpuA = field(lines, "CPU_A:");
    const cpuB = field(lines, "CPU_B:");
    const memTotal = field(lines, "MEM_TOTAL:");
    const memAvail = field(lines, "MEM_AVAIL:");
    const memTotalKb = Number(memTotal);
    const memAvailKb = Number(memAvail);
    const diskUsedKb = Number(field(lines, "DISK_USED:"));
    const diskTotalKb = Number(field(lines, "DISK_TOTAL:"));

    if (!cpuA || !cpuB) return null;
    if (
      !memTotal?.trim() ||
      !memAvail?.trim() ||
      !Number.isFinite(memTotalKb) ||
      memTotalKb <= 0 ||
      !Number.isFinite(memAvailKb) ||
      memAvailKb < 0
    ) {
      return null;
    }

    const cpuPct = cpuPctFromStat(cpuA, cpuB);
    const memPct = ((memTotalKb - memAvailKb) / memTotalKb) * 100;
    const diskPct =
      Number.isFinite(diskTotalKb) && diskTotalKb > 0
        ? (diskUsedKb / diskTotalKb) * 100
        : 0;

    return {
      cpuPct,
      memPct: Math.min(100, Math.max(0, memPct)),
      diskPct: Math.min(100, Math.max(0, diskPct)),
    };
  } catch {
    return null;
  }
}
