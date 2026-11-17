/**
 * @jest-environment node
 */
jest.mock("../utils/sandbox-file-uploader", () => ({
  getSandboxUploadedFileUrl: jest.fn(),
  uploadSandboxFileToConvex: jest.fn(),
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn() },
}));

jest.mock("@/lib/logger", () => ({
  logger: { error: jest.fn() },
}));

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFile } from "../file";
import type { ToolContext } from "@/types";

// The tool's fixed result cap for text reads.
const CAP = 1024 * 1024;

type ReadPayload = {
  content?: string;
  startLine?: number;
  totalLines?: number;
  truncated?: boolean;
  tooLarge?: boolean;
  error?: string;
};

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "hackerai-read-utf8-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// Runs the sandbox command the file tool builds with a local shell, so the
// tool's embedded reader script executes for real against a fixture file.
function makeLocalShellSandbox() {
  const payloads: ReadPayload[] = [];
  const run = jest.fn(
    async (command: string, opts?: { envs?: Record<string, string> }) => {
      const result = spawnSync("bash", ["-c", command], {
        env: { ...process.env, ...opts?.envs },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      payloads.push(JSON.parse(result.stdout.trim()) as ReadPayload);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status ?? 1,
      };
    },
  );
  const sandbox = {
    commands: { run },
    files: {
      read: jest.fn(async () => {
        throw new Error("files.read should not be called");
      }),
      write: jest.fn(),
      remove: jest.fn(),
      list: jest.fn(),
    },
  };
  return { sandbox, payloads };
}

function makeContext(sandbox: unknown): ToolContext {
  return {
    sandboxManager: {
      getSandbox: jest.fn(async () => ({ sandbox })),
      setSandbox: jest.fn(),
      getSandboxType: jest.fn(),
      getSandboxInfo: jest.fn(() => null),
      getEffectivePreference: jest.fn(() => "e2b"),
      recordHealthFailure: jest.fn(() => false),
      resetHealthFailures: jest.fn(),
      isSandboxUnavailable: jest.fn(() => false),
    },
    writer: { write: jest.fn() } as never,
    userLocation: {} as never,
    todoManager: {} as never,
    userID: "user-1",
    chatId: "chat-1",
    fileAccumulator: {} as never,
    backgroundProcessTracker: {} as never,
    ptySessionManager: {} as never,
    mode: "agent",
    modelName: "openai/gpt-5",
    subscription: "pro",
    isE2BSandbox: (() => true) as never,
  };
}

async function readFixture(
  name: string,
  bytes: Buffer,
  range?: [number, number],
): Promise<ReadPayload> {
  const path = join(workDir, name);
  writeFileSync(path, bytes);
  const { sandbox, payloads } = makeLocalShellSandbox();
  const tool = createFile(makeContext(sandbox)) as unknown as {
    execute: (input: unknown, options: unknown) => Promise<unknown>;
  };
  const output = (await tool.execute(
    { action: "read", path, brief: "Read fixture", ...(range && { range }) },
    { toolCallId: "call-1", messages: [] },
  )) as { error?: string };

  expect(output.error).toBeUndefined();
  expect(payloads).toHaveLength(1);
  return payloads[0];
}

const ascii = (length: number) => Buffer.alloc(length, "a");
const utf8 = (text: string) => Buffer.from(text, "utf8");
const encodedLength = (text = "") => Buffer.byteLength(text, "utf8");

// Megabyte-sized contents make unreadable diffs; compare a compact summary
// first, then require exact equality.
function expectContent(actual: string | undefined, expected: string) {
  const summarize = (text = "") => ({
    bytes: encodedLength(text),
    tail: JSON.stringify(text.slice(-4)),
  });
  expect(summarize(actual)).toEqual(summarize(expected));
  expect(actual === expected).toBe(true);
}

describe("file read UTF-8 byte cap", () => {
  test.each([
    ["2-byte", "é", 1],
    ["3-byte", "€", 2],
    ["4-byte", "😀", 3],
  ])(
    "drops a valid %s character split by the cap instead of replacing it",
    async (_label, character, bytesBeforeCap) => {
      const payload = await readFixture(
        `split-${encodedLength(character)}.txt`,
        Buffer.concat([
          ascii(CAP - bytesBeforeCap),
          utf8(`${character}tail\n`),
        ]),
        [1, -1],
      );

      expectContent(payload.content, "a".repeat(CAP - bytesBeforeCap));
      expect(payload.truncated).toBe(true);
      expect(payload.startLine).toBe(1);
      expect(payload.totalLines).toBe(1);
    },
  );

  test("keeps the selected range and line numbers when a later line is split", async () => {
    const payload = await readFixture(
      "ranged.txt",
      Buffer.concat([utf8("skip\n"), ascii(CAP - 1), utf8("€\nlast\n")]),
      [2, 3],
    );

    expectContent(payload.content, "a".repeat(CAP - 1));
    expect(payload.truncated).toBe(true);
    expect(payload.startLine).toBe(2);
    expect(payload.totalLines).toBe(3);
  });

  test("returns an exact-fit multibyte file whole", async () => {
    const text = `${"a".repeat(CAP - 4)}\n€`;
    const payload = await readFixture("exact.txt", utf8(text));

    expect(payload.tooLarge).toBeUndefined();
    expectContent(payload.content, text);
    expect(payload.truncated).toBe(false);
    expect(payload.totalLines).toBe(2);
  });

  test("still truncates plain ASCII at the cap", async () => {
    const payload = await readFixture("ascii.txt", ascii(CAP + 5), [1, 1]);

    expectContent(payload.content, "a".repeat(CAP));
    expect(payload.truncated).toBe(true);
  });

  test("keeps genuine invalid bytes as replacements before a split character", async () => {
    const payload = await readFixture(
      "invalid-then-split.txt",
      Buffer.concat([ascii(CAP - 3), Buffer.from([0xff]), utf8("€\n")]),
      [1, 1],
    );

    const replacement = String.fromCodePoint(0xfffd);
    expectContent(payload.content, `${"a".repeat(CAP - 3)}${replacement}`);
    expect(payload.truncated).toBe(true);
  });

  test("stops before a replacement that would exceed the cap", async () => {
    const payload = await readFixture(
      "invalid-expansion.txt",
      Buffer.concat([ascii(CAP - 2), Buffer.from([0xff, 0xff]), utf8("\n")]),
      [1, 1],
    );

    expectContent(payload.content, "a".repeat(CAP - 2));
    expect(payload.truncated).toBe(true);
  });
});
