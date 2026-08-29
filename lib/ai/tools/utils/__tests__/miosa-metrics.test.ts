/**
 * Tests for sampleMiosaMetrics — live CPU/memory/disk sampling inside a MIOSA
 * sandbox, used by the pre-command health check.
 */

import { sampleMiosaMetrics } from "../miosa-metrics";
import type { MiosaSandbox } from "../miosa-sandbox";

type RunResult = { stdout: string; stderr: string; exitCode: number };

function sandboxReturning(result: RunResult | Error): MiosaSandbox {
  return {
    commands: {
      run: async () => {
        if (result instanceof Error) throw result;
        return result;
      },
    },
  } as unknown as MiosaSandbox;
}

/** Two /proc/stat lines whose delta is 100 busy jiffies out of 200 total. */
const CPU_50_PCT = [
  "CPU_A:cpu  100 0 100 800 0 0 0 0 0 0",
  "CPU_B:cpu  150 0 150 900 0 0 0 0 0 0",
].join("\n");

function probeOutput(overrides: Partial<Record<string, string>> = {}): string {
  const base: Record<string, string> = {
    cpu: CPU_50_PCT,
    memTotal: "MEM_TOTAL:1000000",
    memAvail: "MEM_AVAIL:250000",
    diskUsed: "DISK_USED:2000",
    diskTotal: "DISK_TOTAL:10000",
  };
  const merged = { ...base, ...overrides };
  return [
    merged.cpu,
    merged.memTotal,
    merged.memAvail,
    merged.diskUsed,
    merged.diskTotal,
  ].join("\n");
}

describe("sampleMiosaMetrics", () => {
  it("derives cpu, memory and disk percentages from the guest probe", async () => {
    const sandbox = sandboxReturning({
      stdout: probeOutput(),
      stderr: "",
      exitCode: 0,
    });

    const metrics = await sampleMiosaMetrics(sandbox);

    // busy delta 100 of 200 total jiffies
    expect(metrics?.cpuPct).toBeCloseTo(50, 5);
    // 750000 of 1000000 kB in use
    expect(metrics?.memPct).toBeCloseTo(75, 5);
    // 2000 of 10000 kB used
    expect(metrics?.diskPct).toBeCloseTo(20, 5);
  });

  it("reports 0% CPU for an idle guest rather than NaN", async () => {
    const idle = [
      "CPU_A:cpu  100 0 100 800 0 0 0 0 0 0",
      "CPU_B:cpu  100 0 100 800 0 0 0 0 0 0",
    ].join("\n");

    const metrics = await sampleMiosaMetrics(
      sandboxReturning({
        stdout: probeOutput({ cpu: idle }),
        stderr: "",
        exitCode: 0,
      }),
    );

    expect(metrics?.cpuPct).toBe(0);
  });

  it("returns null when the probe exits non-zero", async () => {
    const metrics = await sampleMiosaMetrics(
      sandboxReturning({ stdout: "", stderr: "boom", exitCode: 1 }),
    );
    expect(metrics).toBeNull();
  });

  it("returns null instead of throwing when the command itself fails", async () => {
    const metrics = await sampleMiosaMetrics(
      sandboxReturning(new Error("sandbox unreachable")),
    );
    expect(metrics).toBeNull();
  });

  it("returns null on unparseable output rather than reporting zeroes", async () => {
    // A sandbox that answers but without the expected fields must not be
    // reported as a perfectly idle machine — that would mask real pressure.
    const metrics = await sampleMiosaMetrics(
      sandboxReturning({ stdout: "unexpected", stderr: "", exitCode: 0 }),
    );
    expect(metrics).toBeNull();
  });

  it("tolerates a guest that reports no disk figures", async () => {
    const metrics = await sampleMiosaMetrics(
      sandboxReturning({
        stdout: [CPU_50_PCT, "MEM_TOTAL:1000000", "MEM_AVAIL:250000"].join(
          "\n",
        ),
        stderr: "",
        exitCode: 0,
      }),
    );

    expect(metrics).not.toBeNull();
    expect(metrics?.diskPct).toBe(0);
    expect(metrics?.memPct).toBeCloseTo(75, 5);
  });

  it("clamps percentages into 0-100", async () => {
    // MemAvailable can briefly exceed MemTotal on some kernels; a negative
    // percentage would render as "-3%" in a warning string.
    const metrics = await sampleMiosaMetrics(
      sandboxReturning({
        stdout: probeOutput({
          memTotal: "MEM_TOTAL:1000",
          memAvail: "MEM_AVAIL:1200",
        }),
        stderr: "",
        exitCode: 0,
      }),
    );

    expect(metrics?.memPct).toBe(0);
  });
});
