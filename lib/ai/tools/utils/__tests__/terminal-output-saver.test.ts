import { createHash } from "node:crypto";
import { describe, expect, it, jest } from "@jest/globals";
import { phLogger } from "@/lib/posthog/server";
import {
  classifyTerminalOutputPersistenceFailure,
  FULL_OUTPUT_SAVE_FAILED_MESSAGE,
  MAX_SAVED_TERMINAL_OUTPUT_FILES,
  saveFullOutputToFile,
  saveTruncatedOutput,
} from "../terminal-output-saver";

const CHAT_ID = "chat_123";
const CHAT_KEY = createHash("sha256")
  .update(CHAT_ID)
  .digest("hex")
  .slice(0, 16);

const createSandbox = ({
  sandboxKind,
  nativeFileRelay = false,
  statSizeBytes,
  listedFiles = [],
}: {
  sandboxKind?: "centrifugo";
  nativeFileRelay?: boolean;
  statSizeBytes?: number;
  listedFiles?: Array<{ name: string }>;
} = {}) => ({
  ...(sandboxKind ? { sandboxKind } : {}),
  ...(sandboxKind ? { supportsNativeFileRelay: () => nativeFileRelay } : {}),
  commands: {
    run: jest.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    })),
  },
  files: {
    ...(statSizeBytes !== undefined
      ? { stat: jest.fn(async () => ({ sizeBytes: statSizeBytes })) }
      : {}),
    write: jest.fn(async () => undefined),
    list: jest.fn(async () => listedFiles),
    remove: jest.fn(async () => undefined),
  },
});

describe("saveFullOutputToFile", () => {
  it("stores cloud output in a chat-scoped directory", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-16T15:30:45.123Z"));
    const sandbox = createSandbox();

    const savedPath = await saveFullOutputToFile(
      sandbox as any,
      "full output",
      CHAT_ID,
    );

    expect(savedPath).toBe(
      `/home/user/terminal_full_output/chat-${CHAT_KEY}/2026-07-16_15-30-45_123Z.txt`,
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      `mkdir -p /home/user/terminal_full_output/chat-${CHAT_KEY}`,
      { timeoutMs: 5000 },
    );
    expect(sandbox.files.write).toHaveBeenCalledWith(savedPath, "full output");
    jest.useRealTimers();
  });

  it("uses the local temporary directory for desktop and remote sandboxes", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-16T15:30:45.123Z"));
    const sandbox = createSandbox({ sandboxKind: "centrifugo" });

    const savedPath = await saveFullOutputToFile(
      sandbox as any,
      "full output",
      CHAT_ID,
    );

    expect(savedPath).toMatch(
      new RegExp(`^/tmp/terminal_full_output/chat-${CHAT_KEY}/`),
    );
    jest.useRealTimers();
  });

  it("retries one transient desktop relay failure and records recovery", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-16T15:30:45.123Z"));
    const sandbox = createSandbox({
      sandboxKind: "centrifugo",
      nativeFileRelay: true,
    });
    sandbox.files.write
      .mockRejectedValueOnce(new Error("Load failed"))
      .mockResolvedValueOnce(undefined);
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    const eventSpy = jest.spyOn(phLogger, "event").mockImplementation(() => {});

    const savePromise = saveFullOutputToFile(
      sandbox as any,
      "full output",
      CHAT_ID,
      {
        service: "agent-long",
        environment: "prod",
        requestId: "run-1",
        triggerRunId: "run-1",
        chatId: CHAT_ID,
      },
    );
    await jest.advanceTimersByTimeAsync(250);

    await expect(savePromise).resolves.toContain(
      `/tmp/terminal_full_output/chat-${CHAT_KEY}/`,
    );
    expect(sandbox.files.write).toHaveBeenCalledTimes(2);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"result":"recovered"'),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"failure_category":"transport"'),
    );
    expect(eventSpy).toHaveBeenCalledWith(
      "terminal_output_persistence_failure",
      expect.objectContaining({
        provider: "desktop",
        attempt_count: 2,
        result: "recovered",
        failure_category: "transport",
        retry_decision: "retried",
      }),
    );

    infoSpy.mockRestore();
    eventSpy.mockRestore();
    jest.useRealTimers();
  });

  it("retries an unknown desktop relay failure once", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-16T15:30:45.123Z"));
    const sandbox = createSandbox({
      sandboxKind: "centrifugo",
      nativeFileRelay: true,
    });
    sandbox.files.write
      .mockRejectedValueOnce({ code: "unclassified_desktop_failure" })
      .mockResolvedValueOnce(undefined);
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});

    const savePromise = saveFullOutputToFile(
      sandbox as any,
      "full output",
      CHAT_ID,
    );
    await jest.advanceTimersByTimeAsync(250);

    await expect(savePromise).resolves.toContain(
      `/tmp/terminal_full_output/chat-${CHAT_KEY}/`,
    );
    expect(sandbox.files.write).toHaveBeenCalledTimes(2);
    infoSpy.mockRestore();
    jest.useRealTimers();
  });

  it("classifies inactive desktop connections as relay unavailable", () => {
    expect(
      classifyTerminalOutputPersistenceFailure({
        reason: "connection_inactive",
      }),
    ).toBe("relay_unavailable");
  });

  it("does not repeat a completed desktop relay timeout", async () => {
    const sandbox = createSandbox({
      sandboxKind: "centrifugo",
      nativeFileRelay: true,
    });
    sandbox.files.write.mockRejectedValueOnce(
      new Error(
        "Desktop file request timed out after 120000ms path=/private/user/evidence.txt",
      ),
    );
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const eventSpy = jest.spyOn(phLogger, "event").mockImplementation(() => {});

    await expect(
      saveFullOutputToFile(sandbox as any, "private command output", CHAT_ID, {
        service: "chat-handler",
        environment: "production",
        requestId: "request-1",
        chatId: CHAT_ID,
      }),
    ).resolves.toBeNull();

    expect(sandbox.files.write).toHaveBeenCalledTimes(1);
    const payload = String(warnSpy.mock.calls[0]?.[0]);
    expect(payload).toContain('"failure_category":"timeout"');
    expect(payload).toContain('"retry_decision":"skipped_timeout"');
    expect(payload).not.toContain("private command output");
    expect(payload).not.toContain("/private/user/evidence.txt");
    expect(eventSpy).toHaveBeenCalledWith(
      "terminal_output_persistence_failure",
      expect.objectContaining({
        provider: "desktop",
        attempt_count: 1,
        result: "failed",
        failure_category: "timeout",
        retry_decision: "skipped_timeout",
      }),
    );

    warnSpy.mockRestore();
    eventSpy.mockRestore();
  });

  it("accepts a completed desktop write whose timeout only lost the ack", async () => {
    const output = "full output";
    const sandbox = createSandbox({
      sandboxKind: "centrifugo",
      nativeFileRelay: true,
      statSizeBytes: Buffer.byteLength(output),
    });
    sandbox.files.write.mockRejectedValueOnce(
      new Error("Desktop file request timed out after 120000ms"),
    );
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      saveFullOutputToFile(sandbox as any, output, CHAT_ID),
    ).resolves.toContain(`/tmp/terminal_full_output/chat-${CHAT_KEY}/`);

    expect(sandbox.files.write).toHaveBeenCalledTimes(1);
    expect((sandbox.files as any).stat).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"retry_decision":"verified_after_timeout"'),
    );

    infoSpy.mockRestore();
  });

  it("uses an unscoped directory when no chat identifier is available", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-16T15:30:45.123Z"));
    const sandbox = createSandbox();

    const savedPath = await saveFullOutputToFile(sandbox as any, "full output");

    expect(savedPath).toBe(
      "/home/user/terminal_full_output/chat-unscoped/2026-07-16_15-30-45_123Z.txt",
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "mkdir -p /home/user/terminal_full_output/chat-unscoped",
      { timeoutMs: 5000 },
    );
    jest.useRealTimers();
  });

  it("tells the agent when truncated output could not be persisted", async () => {
    const sandbox = createSandbox();
    sandbox.files.write.mockRejectedValueOnce(new Error("Permission denied"));
    const terminalWriter = jest.fn(async () => undefined);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const handler = {
      wasTruncated: () => true,
      getFullOutput: () => "full output",
      wasFullOutputCapped: () => false,
    };

    await expect(
      saveTruncatedOutput({
        handler: handler as any,
        sandbox: sandbox as any,
        terminalWriter,
        scopeId: CHAT_ID,
      }),
    ).resolves.toBe(FULL_OUTPUT_SAVE_FAILED_MESSAGE);
    expect(FULL_OUTPUT_SAVE_FAILED_MESSAGE).toContain(
      "Do not rerun the original command unchanged",
    );
    expect(FULL_OUTPUT_SAVE_FAILED_MESSAGE).toContain(
      "use a safe, read-only follow-up",
    );
    expect(terminalWriter).toHaveBeenCalledWith(
      FULL_OUTPUT_SAVE_FAILED_MESSAGE,
    );
    warnSpy.mockRestore();
  });

  it("removes saved outputs beyond the per-chat retention limit", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-16T15:30:45.123Z"));
    const listedFiles = [
      ...Array.from(
        { length: MAX_SAVED_TERMINAL_OUTPUT_FILES + 2 },
        (_, index) => ({
          name: `2026-07-${String(index + 1).padStart(2, "0")}_00-00-00_000Z.txt`,
        }),
      ),
      { name: "2026-07-16_15-30-45_123Z.txt" },
    ];
    const sandbox = createSandbox({ listedFiles });

    await saveFullOutputToFile(sandbox as any, "full output", CHAT_ID);

    expect(sandbox.files.remove).toHaveBeenCalledTimes(3);
    expect(sandbox.files.remove).toHaveBeenNthCalledWith(
      1,
      `/home/user/terminal_full_output/chat-${CHAT_KEY}/2026-07-03_00-00-00_000Z.txt`,
    );
    expect(sandbox.files.remove).toHaveBeenNthCalledWith(
      2,
      `/home/user/terminal_full_output/chat-${CHAT_KEY}/2026-07-02_00-00-00_000Z.txt`,
    );
    expect(sandbox.files.remove).toHaveBeenNthCalledWith(
      3,
      `/home/user/terminal_full_output/chat-${CHAT_KEY}/2026-07-01_00-00-00_000Z.txt`,
    );
    jest.useRealTimers();
  });

  it("still returns the saved path when retention cleanup fails", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-16T15:30:45.123Z"));
    const sandbox = createSandbox();
    sandbox.files.list.mockRejectedValueOnce(new Error("relay unavailable"));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const savedPath = await saveFullOutputToFile(
      sandbox as any,
      "full output",
      CHAT_ID,
    );

    expect(savedPath).toContain(
      `/home/user/terminal_full_output/chat-${CHAT_KEY}/`,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '"event":"terminal_output_retention_prune_failed"',
      ),
    );

    warnSpy.mockRestore();
    jest.useRealTimers();
  });
});

describe("classifyTerminalOutputPersistenceFailure", () => {
  it.each([
    ["Desktop file request timed out after 120000ms", "timeout"],
    ["Load failed", "transport"],
    [
      "Local sandbox connection is not subscribed to the file relay",
      "relay_unavailable",
    ],
    ["Direct file mutation path is outside its allowed root", "permission"],
    ["ENOSPC: no space left on device", "filesystem"],
    ["opaque failure", "unknown"],
  ])("classifies %s as %s", (message, category) => {
    expect(classifyTerminalOutputPersistenceFailure(new Error(message))).toBe(
      category,
    );
  });
});
