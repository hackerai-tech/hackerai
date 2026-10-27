import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

import { AgentLongMemoryTelemetry } from "../agent-long-memory-telemetry";
import type {
  ProviderRequestDiagnostics,
  ProviderRequestRetentionDiagnostics,
} from "@/lib/logger";

const MIB = 1024 * 1024;

const providerRequest: ProviderRequestDiagnostics = {
  model: "model-grok-4.6",
  requested_model_slug: "agent-model",
  step_index: 3,
  source: "prepare_step",
  message_count: 207,
  role_counts: { user: 4, assistant: 203 },
  content_part_counts: { text: 80, "tool-call": 60, "tool-result": 67 },
  serialized_message_bytes: 450_000,
  estimated_serialized_message_tokens: 112_500,
  context_used_tokens: 75_000,
  context_max_tokens: 131_072,
  context_used_percent: 57.2,
  system_tokens: 9_000,
  max_output_tokens: 16_384,
  tool_count: 18,
  active_tool_count: 18,
  active_tools_mode: "all",
  fallback_model_count: 0,
  has_user_attribution: true,
  has_multimodal_tool_results: false,
};

const retention: ProviderRequestRetentionDiagnostics = {
  raw_message_count: 207,
  rolling_message_count: 153,
  final_ui_message_count: 61,
  transcript_source_message_count: 61,
  summarization_count: 2,
  compaction_attempt_count: 3,
};

describe("AgentLongMemoryTelemetry", () => {
  beforeEach(() => {
    jest.spyOn(process, "constrainedMemory").mockReturnValue(0);
  });
  afterEach(() => jest.restoreAllMocks());

  it("emits an initial privacy-safe provider checkpoint", () => {
    jest.spyOn(process, "constrainedMemory").mockReturnValue(1024 * MIB);
    jest.spyOn(process, "resourceUsage").mockReturnValue({
      maxRSS: 512 * 1024,
    } as NodeJS.ResourceUsage);
    const emit = jest.fn();
    const telemetry = new AgentLongMemoryTelemetry({
      runId: "run_123",
      chatId: "chat_123",
      userId: "user_123",
      environment: "production",
      emit,
      now: () => Date.parse("2026-07-24T12:00:00.000Z"),
      readMemory: () => ({
        rss: 300 * MIB,
        heapTotal: 250 * MIB,
        heapUsed: 200 * MIB,
        external: 12 * MIB,
        arrayBuffers: 4 * MIB,
      }),
      readHeapLimit: () => 416 * MIB,
    });

    expect(
      telemetry.checkpoint({
        phase: "provider_request",
        providerRequest,
        retention,
      }),
    ).toBe(true);

    expect(emit).toHaveBeenCalledWith({
      level: "info",
      event: "agent_long_memory_checkpoint",
      service: "agent-long",
      environment: "production",
      timestamp: "2026-07-24T12:00:00.000Z",
      run_id: "run_123",
      chat_id: "chat_123",
      user_id: "user_123",
      phase: "provider_request",
      checkpoint_reason: "initial",
      rss_bytes: 300 * MIB,
      rss_high_water_bytes: 300 * MIB,
      process_rss_os_high_water_bytes: 512 * MIB,
      process_memory_constraint_bytes: 1024 * MIB,
      heap_total_bytes: 250 * MIB,
      heap_used_bytes: 200 * MIB,
      heap_used_high_water_bytes: 200 * MIB,
      heap_limit_bytes: 416 * MIB,
      heap_used_percent: 48.1,
      external_bytes: 12 * MIB,
      array_buffer_bytes: 4 * MIB,
      provider_request: providerRequest,
      retention,
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("prompt");
    expect(JSON.stringify(emit.mock.calls)).not.toContain("target");
  });

  it("keeps the OS process peak distinct from sampled run highs without adding checkpoints", () => {
    const readMemoryConstraint = jest
      .spyOn(process, "constrainedMemory")
      .mockReturnValue(1024 * MIB);
    const readResourceUsage = jest
      .spyOn(process, "resourceUsage")
      .mockReturnValue({ maxRSS: 900 * 1024 } as NodeJS.ResourceUsage);
    const emit = jest.fn();
    const telemetry = new AgentLongMemoryTelemetry({
      runId: "run_123",
      chatId: "chat_123",
      userId: "user_123",
      emit,
      now: () => 1_000,
      readMemory: () => ({
        rss: 300 * MIB,
        heapTotal: 250 * MIB,
        heapUsed: 200 * MIB,
        external: 0,
        arrayBuffers: 0,
      }),
      readHeapLimit: () => 416 * MIB,
    });

    expect(telemetry.checkpoint({ phase: "provider_request" })).toBe(true);
    expect(telemetry.checkpoint({ phase: "provider_request" })).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(readResourceUsage).toHaveBeenCalledTimes(1);
    expect(readMemoryConstraint).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        rss_bytes: 300 * MIB,
        rss_high_water_bytes: 300 * MIB,
        process_rss_os_high_water_bytes: 900 * MIB,
      }),
    );
  });

  it.each([0, -1, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5])(
    "omits an unknown or unusable OS memory constraint (%s)",
    (bytes) => {
      jest.spyOn(process, "constrainedMemory").mockReturnValue(bytes);
      const emit = jest.fn();
      const telemetry = new AgentLongMemoryTelemetry({
        runId: "run_123",
        chatId: "chat_123",
        userId: "user_123",
        emit,
      });

      expect(telemetry.checkpoint({ phase: "provider_request" })).toBe(true);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0][0]).not.toHaveProperty(
        "process_memory_constraint_bytes",
      );
    },
  );

  it("retains the checkpoint when the OS memory constraint cannot be read", () => {
    jest.spyOn(process, "constrainedMemory").mockImplementation(() => {
      throw new Error("unavailable memory constraint");
    });
    const emit = jest.fn();
    const telemetry = new AgentLongMemoryTelemetry({
      runId: "run_123",
      chatId: "chat_123",
      userId: "user_123",
      emit,
    });

    expect(telemetry.checkpoint({ phase: "run_failed", force: true })).toBe(
      true,
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ event: "agent_long_memory_checkpoint" }),
    );
    expect(emit.mock.calls[0][0]).not.toHaveProperty(
      "process_memory_constraint_bytes",
    );
  });

  it("retains the original checkpoint if the OS peak read fails", () => {
    jest.spyOn(process, "resourceUsage").mockImplementation(() => {
      throw new Error("unavailable resource usage");
    });
    const emit = jest.fn();
    const telemetry = new AgentLongMemoryTelemetry({
      runId: "run_123",
      chatId: "chat_123",
      userId: "user_123",
      emit,
    });

    expect(telemetry.checkpoint({ phase: "run_failed", force: true })).toBe(
      true,
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "run_failed",
        checkpoint_reason: "initial",
      }),
    );
    expect(emit.mock.calls[0][0]).not.toHaveProperty(
      "process_rss_os_high_water_bytes",
    );
  });

  it.each([0, Number.NaN, Number.MAX_VALUE])(
    "omits an unusable OS peak (%s) while retaining the checkpoint",
    (maxRSS) => {
      jest
        .spyOn(process, "resourceUsage")
        .mockReturnValue({ maxRSS } as NodeJS.ResourceUsage);
      const emit = jest.fn();
      const telemetry = new AgentLongMemoryTelemetry({
        runId: "run_123",
        chatId: "chat_123",
        userId: "user_123",
        emit,
      });

      expect(telemetry.checkpoint({ phase: "provider_request" })).toBe(true);
      expect(emit.mock.calls[0][0]).not.toHaveProperty(
        "process_rss_os_high_water_bytes",
      );
    },
  );

  it("emits only after meaningful heap growth", () => {
    let heapUsed = 100 * MIB;
    const emit = jest.fn();
    const telemetry = new AgentLongMemoryTelemetry({
      runId: "run_123",
      chatId: "chat_123",
      userId: "user_123",
      emit,
      now: () => 1_000,
      readMemory: () => ({
        rss: 200 * MIB,
        heapTotal: 180 * MIB,
        heapUsed,
        external: 0,
        arrayBuffers: 0,
      }),
      readHeapLimit: () => 416 * MIB,
    });

    expect(telemetry.checkpoint({ phase: "provider_request" })).toBe(true);
    heapUsed += 31 * MIB;
    expect(telemetry.checkpoint({ phase: "provider_request" })).toBe(false);
    heapUsed += 1 * MIB;
    expect(telemetry.checkpoint({ phase: "provider_request" })).toBe(true);
    expect(emit.mock.calls[1]?.[0]).toMatchObject({
      checkpoint_reason: "heap_growth",
      heap_used_bytes: 132 * MIB,
      heap_used_high_water_bytes: 132 * MIB,
    });
  });

  it("emits an interval checkpoint for long stable streams", () => {
    let now = 0;
    const emit = jest.fn();
    const telemetry = new AgentLongMemoryTelemetry({
      runId: "run_123",
      chatId: "chat_123",
      userId: "user_123",
      emit,
      now: () => now,
      readMemory: () => ({
        rss: 200 * MIB,
        heapTotal: 180 * MIB,
        heapUsed: 100 * MIB,
        external: 0,
        arrayBuffers: 0,
      }),
      readHeapLimit: () => 416 * MIB,
    });

    telemetry.checkpoint({ phase: "provider_request" });
    now = 9 * 60 * 1_000;
    expect(telemetry.checkpoint({ phase: "provider_request" })).toBe(false);
    now = 10 * 60 * 1_000;
    expect(telemetry.checkpoint({ phase: "provider_request" })).toBe(true);
    expect(emit.mock.calls[1]?.[0]).toMatchObject({
      checkpoint_reason: "interval",
    });
  });

  it("emits bounded periodic checkpoints during long provider work", () => {
    jest.useFakeTimers();
    try {
      let now = 0;
      const emit = jest.fn();
      const telemetry = new AgentLongMemoryTelemetry({
        runId: "run_123",
        chatId: "chat_123",
        userId: "user_123",
        emit,
        now: () => now,
        readMemory: () => ({
          rss: 220 * MIB,
          heapTotal: 180 * MIB,
          heapUsed: 110 * MIB,
          external: 0,
          arrayBuffers: 0,
        }),
        readHeapLimit: () => 416 * MIB,
      });

      now = 30 * 1_000;
      telemetry.checkpoint({
        phase: "provider_request",
        providerRequest,
        retention,
      });
      telemetry.startPeriodicCheckpoints();
      now += 2 * 60 * 1_000 - 1;
      jest.advanceTimersByTime(2 * 60 * 1_000 - 1);
      expect(emit).toHaveBeenCalledTimes(1);

      now += 1;
      jest.advanceTimersByTime(1);

      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit.mock.calls[1]?.[0]).toMatchObject({
        checkpoint_reason: "periodic",
        phase: "provider_request",
        provider_request: providerRequest,
        retention,
      });

      telemetry.dispose();
      now += 2 * 60 * 1_000;
      jest.advanceTimersByTime(2 * 60 * 1_000);
      expect(emit).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("captures rapid heap growth before a short provider operation ends", () => {
    jest.useFakeTimers();
    try {
      let heapUsed = 100 * MIB;
      const emit = jest.fn();
      const telemetry = new AgentLongMemoryTelemetry({
        runId: "run_short",
        chatId: "chat_short",
        userId: "user_short",
        emit,
        readMemory: () => ({
          rss: heapUsed + 100 * MIB,
          heapTotal: heapUsed + 50 * MIB,
          heapUsed,
          external: 0,
          arrayBuffers: 0,
        }),
        readHeapLimit: () => 416 * MIB,
      });
      telemetry.checkpoint({
        phase: "provider_request",
        providerRequest,
        retention,
      });
      telemetry.startPeriodicCheckpoints();
      telemetry.startPeriodicCheckpoints();
      expect(jest.getTimerCount()).toBe(1);

      heapUsed += 32 * MIB;
      jest.advanceTimersByTime(9_999);
      expect(emit).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      expect(emit.mock.calls[1]?.[0]).toMatchObject({
        checkpoint_reason: "heap_growth",
        heap_used_bytes: 132 * MIB,
        provider_request: providerRequest,
        retention,
      });

      heapUsed += 31 * MIB;
      jest.advanceTimersByTime(10_000);
      expect(emit).toHaveBeenCalledTimes(2);
      heapUsed += MIB;
      jest.advanceTimersByTime(10_000);
      expect(emit.mock.calls[2]?.[0]).toMatchObject({
        checkpoint_reason: "heap_growth",
        heap_used_high_water_bytes: 164 * MIB,
      });

      telemetry.dispose();
      expect(jest.getTimerCount()).toBe(0);
      heapUsed += 64 * MIB;
      jest.advanceTimersByTime(120_000);
      expect(emit).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps quiet sampling silent and waits two minutes after a growth emission", () => {
    jest.useFakeTimers();
    try {
      let heapUsed = 100 * MIB;
      const emit = jest.fn();
      const telemetry = new AgentLongMemoryTelemetry({
        runId: "run_quiet",
        chatId: "chat_quiet",
        userId: "user_quiet",
        emit,
        readMemory: () => ({
          rss: 250 * MIB,
          heapTotal: 220 * MIB,
          heapUsed,
          external: 0,
          arrayBuffers: 0,
        }),
      });
      telemetry.checkpoint({ phase: "provider_request" });
      telemetry.startPeriodicCheckpoints();
      jest.advanceTimersByTime(90_000);
      expect(emit).toHaveBeenCalledTimes(1);

      heapUsed += 32 * MIB;
      jest.advanceTimersByTime(10_000);
      expect(emit.mock.calls[1]?.[0]).toMatchObject({
        checkpoint_reason: "heap_growth",
      });
      jest.advanceTimersByTime(119_999);
      expect(emit).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(1);
      expect(emit.mock.calls[2]?.[0]).toMatchObject({
        checkpoint_reason: "periodic",
      });

      jest.advanceTimersByTime(110_000);
      heapUsed += 32 * MIB;
      jest.advanceTimersByTime(10_000);
      expect(emit.mock.calls[3]?.[0]).toMatchObject({
        checkpoint_reason: "heap_growth",
        heap_used_bytes: 164 * MIB,
      });
      telemetry.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("isolates timer collector failures and retains the latest provider context", () => {
    jest.useFakeTimers();
    try {
      let unavailable = false;
      let heapUsed = 100 * MIB;
      const emit = jest.fn();
      const telemetry = new AgentLongMemoryTelemetry({
        runId: "run_failure",
        chatId: "chat_failure",
        userId: "user_failure",
        emit,
        readMemory: () => {
          if (unavailable) throw new Error("private collector failure");
          return {
            rss: 250 * MIB,
            heapTotal: 220 * MIB,
            heapUsed,
            external: 0,
            arrayBuffers: 0,
          };
        },
      });
      telemetry.checkpoint({ phase: "provider_request", providerRequest });
      telemetry.startPeriodicCheckpoints();
      const nextRequest = { ...providerRequest, step_index: 4 };
      telemetry.checkpoint({
        phase: "provider_request",
        providerRequest: nextRequest,
        retention,
      });
      unavailable = true;
      expect(() => jest.advanceTimersByTime(10_000)).not.toThrow();
      expect(emit).toHaveBeenCalledTimes(1);
      unavailable = false;
      heapUsed += 32 * MIB;
      jest.advanceTimersByTime(10_000);
      expect(emit.mock.calls[1]?.[0]).toMatchObject({
        checkpoint_reason: "heap_growth",
        provider_request: nextRequest,
        retention,
      });
      expect(JSON.stringify(emit.mock.calls)).not.toContain(
        "private collector failure",
      );
      telemetry.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("forces a failure checkpoint and keeps prior high-water values", () => {
    let heapUsed = 200 * MIB;
    const emit = jest.fn();
    const telemetry = new AgentLongMemoryTelemetry({
      runId: "run_123",
      chatId: "chat_123",
      userId: "user_123",
      emit,
      now: () => 1_000,
      readMemory: () => ({
        rss: heapUsed + 50 * MIB,
        heapTotal: 220 * MIB,
        heapUsed,
        external: 0,
        arrayBuffers: 0,
      }),
      readHeapLimit: () => 0,
    });

    telemetry.checkpoint({ phase: "provider_request" });
    heapUsed = 150 * MIB;
    expect(telemetry.checkpoint({ phase: "run_failed", force: true })).toBe(
      true,
    );
    expect(emit.mock.calls[1]?.[0]).toMatchObject({
      checkpoint_reason: "forced",
      rss_high_water_bytes: 250 * MIB,
      heap_used_high_water_bytes: 200 * MIB,
      heap_used_percent: 0,
    });
  });

  it("does not propagate memory collector failures", () => {
    const emit = jest.fn();
    const telemetry = new AgentLongMemoryTelemetry({
      runId: "run_123",
      chatId: "chat_123",
      userId: "user_123",
      emit,
      readMemory: () => {
        throw new Error("memory stats unavailable");
      },
    });

    expect(telemetry.checkpoint({ phase: "run_failed", force: true })).toBe(
      false,
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not mark a failed emission as a completed checkpoint", () => {
    const emit = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("logger unavailable");
      })
      .mockImplementation(() => undefined);
    const telemetry = new AgentLongMemoryTelemetry({
      runId: "run_123",
      chatId: "chat_123",
      userId: "user_123",
      emit,
      now: () => 1_000,
      readMemory: () => ({
        rss: 200 * MIB,
        heapTotal: 180 * MIB,
        heapUsed: 100 * MIB,
        external: 0,
        arrayBuffers: 0,
      }),
      readHeapLimit: () => 416 * MIB,
    });

    expect(telemetry.checkpoint({ phase: "provider_request" })).toBe(false);
    expect(telemetry.checkpoint({ phase: "provider_request" })).toBe(true);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]?.[0]).toMatchObject({
      checkpoint_reason: "initial",
    });
  });
});
