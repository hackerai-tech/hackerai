import { createHash } from "node:crypto";
import { describe, expect, it, jest } from "@jest/globals";
import {
  MAX_SAVED_TERMINAL_OUTPUT_FILES,
  saveFullOutputToFile,
} from "../terminal-output-saver";

const CHAT_ID = "chat_123";
const CHAT_KEY = createHash("sha256")
  .update(CHAT_ID)
  .digest("hex")
  .slice(0, 16);

const createSandbox = ({
  sandboxKind,
  listedFiles = [],
}: {
  sandboxKind?: "centrifugo";
  listedFiles?: Array<{ name: string }>;
} = {}) => ({
  ...(sandboxKind ? { sandboxKind } : {}),
  commands: {
    run: jest.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    })),
  },
  files: {
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
      "[Terminal Command] Failed to prune old saved terminal output:",
      expect.any(Error),
    );

    warnSpy.mockRestore();
    jest.useRealTimers();
  });
});
