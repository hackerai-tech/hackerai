import { getHeapStatistics } from "node:v8";

import type {
  ProviderRequestDiagnostics,
  ProviderRequestRetentionDiagnostics,
} from "@/lib/logger";

const HEAP_GROWTH_CHECKPOINT_BYTES = 32 * 1024 * 1024;
const CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000;

type MemorySnapshot = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

type MemoryCheckpointPhase =
  "provider_request" | "stream_finished" | "run_failed";

type MemoryCheckpointInput = {
  phase: MemoryCheckpointPhase;
  force?: boolean;
  providerRequest?: ProviderRequestDiagnostics;
  retention?: ProviderRequestRetentionDiagnostics;
};

type MemoryCheckpointEvent = {
  level: "info";
  event: "agent_long_memory_checkpoint";
  service: "agent-long";
  environment: string;
  timestamp: string;
  run_id: string;
  chat_id: string;
  user_id: string;
  phase: MemoryCheckpointPhase;
  checkpoint_reason: "initial" | "forced" | "heap_growth" | "interval";
  rss_bytes: number;
  rss_high_water_bytes: number;
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

type AgentLongMemoryTelemetryOptions = {
  runId: string;
  chatId: string;
  userId: string;
  environment?: string;
  emit: (event: MemoryCheckpointEvent) => void;
  now?: () => number;
  readMemory?: () => MemorySnapshot;
  readHeapLimit?: () => number;
};

const finiteNonNegative = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

export class AgentLongMemoryTelemetry {
  private readonly now: () => number;
  private readonly readMemory: () => MemorySnapshot;
  private readonly readHeapLimit: () => number;
  private lastEmittedAt: number | undefined;
  private lastEmittedHeapUsed = 0;
  private rssHighWater = 0;
  private heapUsedHighWater = 0;

  constructor(private readonly options: AgentLongMemoryTelemetryOptions) {
    this.now = options.now ?? Date.now;
    this.readMemory = options.readMemory ?? process.memoryUsage;
    this.readHeapLimit =
      options.readHeapLimit ?? (() => getHeapStatistics().heap_size_limit);
  }

  checkpoint(input: MemoryCheckpointInput): boolean {
    const now = this.now();
    const memory = this.readMemory();
    const rss = finiteNonNegative(memory.rss);
    const heapTotal = finiteNonNegative(memory.heapTotal);
    const heapUsed = finiteNonNegative(memory.heapUsed);
    const external = finiteNonNegative(memory.external);
    const arrayBuffers = finiteNonNegative(memory.arrayBuffers);
    const heapLimit = finiteNonNegative(this.readHeapLimit());

    this.rssHighWater = Math.max(this.rssHighWater, rss);
    this.heapUsedHighWater = Math.max(this.heapUsedHighWater, heapUsed);

    const reason =
      this.lastEmittedAt === undefined
        ? "initial"
        : input.force
          ? "forced"
          : heapUsed - this.lastEmittedHeapUsed >= HEAP_GROWTH_CHECKPOINT_BYTES
            ? "heap_growth"
            : now - this.lastEmittedAt >= CHECKPOINT_INTERVAL_MS
              ? "interval"
              : undefined;

    if (!reason) return false;

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
      rss_bytes: rss,
      rss_high_water_bytes: this.rssHighWater,
      heap_total_bytes: heapTotal,
      heap_used_bytes: heapUsed,
      heap_used_high_water_bytes: this.heapUsedHighWater,
      heap_limit_bytes: heapLimit,
      heap_used_percent:
        heapLimit > 0 ? Math.round((heapUsed / heapLimit) * 1000) / 10 : 0,
      external_bytes: external,
      array_buffer_bytes: arrayBuffers,
      provider_request: input.providerRequest,
      retention: input.retention,
    });
    this.lastEmittedAt = now;
    this.lastEmittedHeapUsed = heapUsed;
    return true;
  }
}
