import { getHeapStatistics } from "node:v8";
import { openSync, readSync, closeSync } from "node:fs";

import type {
  ProviderRequestDiagnostics,
  ProviderRequestRetentionDiagnostics,
} from "@/lib/logger";

const MEMORY_GROWTH_CHECKPOINT_BYTES = 32 * 1024 * 1024;
const CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000;
const PERIODIC_CHECKPOINT_INTERVAL_MS = 2 * 60 * 1000;
const MEMORY_SAMPLE_INTERVAL_MS = 10 * 1000;

type MemorySnapshot = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

type V8MemorySnapshot = Pick<
  ReturnType<typeof getHeapStatistics>,
  "total_physical_size" | "malloced_memory" | "peak_malloced_memory"
>;

type V8MemoryFields = {
  v8_heap_physical_bytes?: number;
  v8_malloced_bytes?: number;
  v8_malloced_peak_bytes?: number;
};

type MemoryCheckpointPhase =
  "provider_request" | "stream_finished" | "run_failed";

type MemoryCheckpointInput = {
  phase: MemoryCheckpointPhase;
  force?: boolean;
  providerRequest?: ProviderRequestDiagnostics;
  retention?: ProviderRequestRetentionDiagnostics;
};

type MemoryCheckpointEvent = V8MemoryFields & {
  level: "info";
  event: "agent_long_memory_checkpoint";
  service: "agent-long";
  environment: string;
  timestamp: string;
  run_id: string;
  chat_id: string;
  user_id: string;
  phase: MemoryCheckpointPhase;
  checkpoint_reason:
    | "initial"
    | "forced"
    | "heap_growth"
    | "rss_growth"
    | "external_growth"
    | "interval"
    | "periodic";
  sample_gap_ms?: number;
  sample_gap_high_water_ms?: number;
  rss_bytes: number;
  rss_high_water_bytes: number;
  process_rss_os_high_water_bytes?: number;
  process_memory_constraint_bytes?: number;
  process_available_memory_bytes?: number;
  process_rss_anon_bytes?: number;
  process_rss_file_bytes?: number;
  process_rss_shmem_bytes?: number;
  heap_total_bytes: number;
  heap_used_bytes: number;
  heap_used_high_water_bytes: number;
  heap_limit_bytes: number;
  heap_used_percent: number;
  external_bytes: number;
  array_buffer_bytes: number;
  provider_request?: ProviderRequestDiagnostics;
  retention?: ProviderRequestRetentionDiagnostics;
};

type ProcessRssFields = Pick<
  MemoryCheckpointEvent,
  | "process_rss_anon_bytes"
  | "process_rss_file_bytes"
  | "process_rss_shmem_bytes"
>;

type AgentLongMemoryTelemetryOptions = {
  runId: string;
  chatId: string;
  userId: string;
  environment?: string;
  emit: (event: MemoryCheckpointEvent) => void;
  now?: () => number;
  readMemory?: () => MemorySnapshot;
  readHeapLimit?: () => number;
  readV8Memory?: () => V8MemorySnapshot;
};

const finiteNonNegative = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

const readProcessRssOsHighWaterBytes = (): number | undefined => {
  try {
    // Node reports OS maxRSS in KiB for the process lifetime. It can include
    // previous runs in a reused process and is not a container/kill-time peak.
    const bytes = process.resourceUsage().maxRSS * 1024;
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
};

const readProcessMemoryConstraintBytes = (): number | undefined => {
  try {
    // Node returns zero for an unknown or unconstrained OS memory bound.
    // This is a process constraint reading, not a measured kill-time limit.
    const bytes = process.constrainedMemory();
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
};

const readProcessAvailableMemoryBytes = (): number | undefined => {
  try {
    // OS-reported free headroom, not constraint minus this process's RSS.
    // Zero is a valid reading; missing/invalid readings stay absent.
    const bytes = process.availableMemory();
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
};

const readV8MemoryFields = (read: () => V8MemorySnapshot): V8MemoryFields => {
  try {
    const stats = read();
    const fields: V8MemoryFields = {};
    // These overlap other heap metrics; they are not a disjoint RSS breakdown.
    // V8's malloc peak is process-lifetime and can include a previous run.
    for (const [key, bytes] of [
      ["v8_heap_physical_bytes", stats.total_physical_size],
      ["v8_malloced_bytes", stats.malloced_memory],
      ["v8_malloced_peak_bytes", stats.peak_malloced_memory],
    ] as const) {
      if (Number.isSafeInteger(bytes) && bytes >= 0) fields[key] = bytes;
    }
    return fields;
  } catch {
    // Optional attribution must not suppress the existing checkpoint.
    return {};
  }
};

const readProcessRssFields = (): ProcessRssFields => {
  if (process.platform !== "linux") return {};
  let fd: number | undefined;
  try {
    fd = openSync("/proc/self/status", "r");
    const buffer = Buffer.alloc(8192);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const status = buffer.toString("utf8", 0, length);
    const fields: ProcessRssFields = {};
    // Kernel RSS backing counters are approximate and process-wide. This read
    // is separate from memoryUsage(); neither is an exact kill-time snapshot.
    for (const [source, target] of [
      ["RssAnon", "process_rss_anon_bytes"],
      ["RssFile", "process_rss_file_bytes"],
      ["RssShmem", "process_rss_shmem_bytes"],
    ] as const) {
      const value = status.match(
        new RegExp(`^${source}:[ \\t]+(\\d+) kB$`, "m"),
      );
      if (!value) continue;
      const bytes = Number(value[1]) * 1024;
      if (Number.isSafeInteger(bytes) && bytes >= 0) fields[target] = bytes;
    }
    return fields;
  } catch {
    // Optional attribution must not suppress the existing checkpoint.
    return {};
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Keep diagnostics isolated from run behavior, including cleanup errors.
      }
    }
  }
};

export class AgentLongMemoryTelemetry {
  private readonly now: () => number;
  private readonly readMemory: () => MemorySnapshot;
  private readonly readHeapLimit: () => number;
  private readonly readV8Memory: () => V8MemorySnapshot;
  private lastEmittedAt: number | undefined;
  private lastEmittedHeapUsed = 0;
  private lastEmittedRss = 0;
  private lastEmittedExternal = 0;
  private lastSampleAt: number | undefined;
  private sampleGapHighWater = 0;
  private rssHighWater = 0;
  private heapUsedHighWater = 0;
  private latestInput: MemoryCheckpointInput | undefined;
  private periodicTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: AgentLongMemoryTelemetryOptions) {
    this.now = options.now ?? Date.now;
    this.readMemory = options.readMemory ?? process.memoryUsage;
    this.readHeapLimit =
      options.readHeapLimit ?? (() => getHeapStatistics().heap_size_limit);
    this.readV8Memory = options.readV8Memory ?? getHeapStatistics;
  }

  startPeriodicCheckpoints(): void {
    if (this.periodicTimer) return;

    this.periodicTimer = setInterval(() => {
      if (!this.latestInput) return;
      // Short runs can exhaust memory between provider callbacks. Sample often,
      // but retain growth gates and the quiet-stream reporting interval.
      this.captureCheckpoint(this.latestInput, true);
    }, MEMORY_SAMPLE_INTERVAL_MS);
    this.periodicTimer.unref?.();
  }

  dispose(): void {
    if (!this.periodicTimer) return;
    clearInterval(this.periodicTimer);
    this.periodicTimer = undefined;
  }

  checkpoint(input: MemoryCheckpointInput): boolean {
    this.latestInput = {
      phase: input.phase,
      providerRequest: input.providerRequest,
      retention: input.retention,
    };
    return this.captureCheckpoint(input);
  }

  private captureCheckpoint(
    input: MemoryCheckpointInput,
    periodicSample = false,
  ): boolean {
    try {
      const now = this.now();
      const memory = this.readMemory();
      const rss = finiteNonNegative(memory.rss);
      const heapTotal = finiteNonNegative(memory.heapTotal);
      const heapUsed = finiteNonNegative(memory.heapUsed);
      const external = finiteNonNegative(memory.external);
      const arrayBuffers = finiteNonNegative(memory.arrayBuffers);
      const heapLimit = finiteNonNegative(this.readHeapLimit());
      const sampleGap =
        this.lastSampleAt === undefined
          ? undefined
          : finiteNonNegative(now - this.lastSampleAt);
      this.lastSampleAt = now;
      this.sampleGapHighWater = Math.max(
        this.sampleGapHighWater,
        sampleGap ?? 0,
      );

      this.rssHighWater = Math.max(this.rssHighWater, rss);
      this.heapUsedHighWater = Math.max(this.heapUsedHighWater, heapUsed);

      const reason =
        this.lastEmittedAt === undefined
          ? "initial"
          : input.force
            ? "forced"
            : heapUsed - this.lastEmittedHeapUsed >=
                MEMORY_GROWTH_CHECKPOINT_BYTES
              ? "heap_growth"
              : rss - this.lastEmittedRss >= MEMORY_GROWTH_CHECKPOINT_BYTES
                ? "rss_growth"
                : external - this.lastEmittedExternal >=
                    MEMORY_GROWTH_CHECKPOINT_BYTES
                  ? "external_growth"
                  : periodicSample &&
                      now - this.lastEmittedAt >=
                        PERIODIC_CHECKPOINT_INTERVAL_MS
                    ? "periodic"
                    : now - this.lastEmittedAt >= CHECKPOINT_INTERVAL_MS
                      ? "interval"
                      : undefined;

      if (!reason) return false;

      const processRssOsHighWater = readProcessRssOsHighWaterBytes();
      const processMemoryConstraint = readProcessMemoryConstraintBytes();
      const processAvailableMemory = readProcessAvailableMemoryBytes();
      this.options.emit({
        level: "info",
        event: "agent_long_memory_checkpoint",
        service: "agent-long",
        environment:
          this.options.environment ??
          process.env.VERCEL_ENV ??
          process.env.NODE_ENV ??
          "unknown",
        timestamp: new Date(now).toISOString(),
        run_id: this.options.runId,
        chat_id: this.options.chatId,
        user_id: this.options.userId,
        phase: input.phase,
        checkpoint_reason: reason,
        // Time between successful in-process samples, not a physical OOM peak
        // or proof of why a callback/log export was absent before a kill.
        ...(sampleGap === undefined
          ? {}
          : {
              sample_gap_ms: sampleGap,
              sample_gap_high_water_ms: this.sampleGapHighWater,
            }),
        rss_bytes: rss,
        rss_high_water_bytes: this.rssHighWater,
        ...(processRssOsHighWater === undefined
          ? {}
          : { process_rss_os_high_water_bytes: processRssOsHighWater }),
        ...(processMemoryConstraint === undefined
          ? {}
          : { process_memory_constraint_bytes: processMemoryConstraint }),
        ...(processAvailableMemory === undefined
          ? {}
          : { process_available_memory_bytes: processAvailableMemory }),
        heap_total_bytes: heapTotal,
        heap_used_bytes: heapUsed,
        heap_used_high_water_bytes: this.heapUsedHighWater,
        heap_limit_bytes: heapLimit,
        heap_used_percent:
          heapLimit > 0 ? Math.round((heapUsed / heapLimit) * 1000) / 10 : 0,
        external_bytes: external,
        array_buffer_bytes: arrayBuffers,
        ...readV8MemoryFields(this.readV8Memory),
        ...readProcessRssFields(),
        provider_request: input.providerRequest,
        retention: input.retention,
      });
      this.lastEmittedAt = now;
      this.lastEmittedHeapUsed = heapUsed;
      this.lastEmittedRss = rss;
      this.lastEmittedExternal = external;
      return true;
    } catch {
      return false;
    }
  }
}
