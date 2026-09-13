import {
  collectAgentAutoReviewTerminalInspection,
  getAgentAutoReviewInspectionKind,
  terminalInspectionMatches,
  tokenizeStaticTerminalCommand,
} from "@/lib/chat/agent-auto-review-evidence";
import type { AnySandbox } from "@/types";

type FakeEntry = {
  type: "file" | "dir" | "symlink";
  size?: number;
  modifiedTime?: Date;
  symlinkTarget?: string;
  children?: string[];
  content?: string;
};

const makeSandbox = (entries: Record<string, FakeEntry>): AnySandbox => {
  const files = {
    exists: jest.fn(async (candidate: string) => candidate in entries),
    getInfo: jest.fn(async (candidate: string) => {
      const entry = entries[candidate];
      if (!entry) throw new Error("missing");
      return {
        name: candidate.split("/").pop() ?? candidate,
        path: candidate,
        type: entry.type,
        size: entry.size ?? 0,
        mode: 0,
        permissions: "",
        owner: "root",
        group: "root",
        modifiedTime: entry.modifiedTime,
        symlinkTarget: entry.symlinkTarget,
      };
    }),
    list: jest.fn(async (candidate: string) =>
      (entries[candidate]?.children ?? []).map((child) => ({
        name: child.split("/").pop() ?? child,
        path: child,
      })),
    ),
    read: jest.fn(async (candidate: string) => {
      const entry = entries[candidate];
      if (!entry || entry.type !== "file") throw new Error("missing");
      return entry.content ?? "";
    }),
  };
  return { files, commands: { run: jest.fn() } } as unknown as AnySandbox;
};

describe("Agent Auto review terminal evidence", () => {
  it("tokenizes only static shell commands", () => {
    expect(tokenizeStaticTerminalCommand("rm -rf 'build output'")).toEqual([
      "rm",
      "-rf",
      "build output",
    ]);
    expect(tokenizeStaticTerminalCommand("rm -rf $TARGET")).toBeNull();
    expect(
      tokenizeStaticTerminalCommand("rm -rf build && echo done"),
    ).toBeNull();
    expect(tokenizeStaticTerminalCommand("bash -c 'rm -rf build'")).toEqual([
      "bash",
      "-c",
      "rm -rf build",
    ]);
  });

  it.each([
    ["rm -rf build", "filesystem_delete"],
    ["./scripts/test.sh", "script"],
    ["bash scripts/test.sh", "script"],
    ["pnpm run test", "package_task"],
    ["pnpm test", "package_task"],
    ["pnpm install", null],
    ["sh -c 'rm -rf build'", "script"],
    ["sudo -u root rm -rf build", "filesystem_delete"],
    ["git status", null],
  ] as const)("classifies %s as %s", (command, expected) => {
    expect(getAgentAutoReviewInspectionKind(command)).toBe(expected);
  });

  it("resolves a narrow workspace deletion including bounded directory contents", async () => {
    const sandbox = makeSandbox({
      "/home/user/build": {
        type: "dir",
        children: ["/home/user/build/result.txt"],
      },
      "/home/user/build/result.txt": {
        type: "file",
        size: 12,
        modifiedTime: new Date("2026-08-13T00:00:00Z"),
      },
    });

    await expect(
      collectAgentAutoReviewTerminalInspection({
        command: "rm -rf build",
        sandbox,
      }),
    ).resolves.toMatchObject({
      kind: "filesystem_delete",
      status: "resolved",
      workingDirectory: "/home/user",
      targets: [
        {
          path: "/home/user/build",
          scope: "workspace",
          state: "directory",
          entryCount: 1,
        },
      ],
      fingerprint: expect.any(String),
    });
  });

  it("treats a missing specific temporary target as resolved evidence", async () => {
    const sandbox = makeSandbox({});
    await expect(
      collectAgentAutoReviewTerminalInspection({
        command: "rm -f /tmp/hackerai-stale.txt",
        sandbox,
      }),
    ).resolves.toMatchObject({
      status: "resolved",
      targets: [
        {
          path: "/tmp/hackerai-stale.txt",
          scope: "temporary",
          state: "missing",
        },
      ],
    });
  });

  it.each([
    ["rm -rf /var/data", "outside_scope"],
    ["rm -rf .git", "sensitive_target"],
    ["rm -rf .", "too_broad"],
    ["rm -rf $TARGET", "dynamic_command"],
    ["rm -rf ~/documents", "dynamic_command"],
    ["rm -rf build/{a,b}", "dynamic_command"],
    ["rm -rf build/[ab]*", "dynamic_command"],
    ["shred build/output.bin", "dynamic_command"],
  ] as const)("fails closed for %s", async (command, reason) => {
    await expect(
      collectAgentAutoReviewTerminalInspection({
        command,
        sandbox: makeSandbox({}),
      }),
    ).resolves.toMatchObject({ status: "unresolved", reason });
  });

  it("fails closed for opaque interpreter expressions", async () => {
    await expect(
      collectAgentAutoReviewTerminalInspection({
        command: "sh -c 'rm -rf build'",
        sandbox: makeSandbox({}),
      }),
    ).resolves.toMatchObject({
      kind: "script",
      status: "unresolved",
      reason: "dynamic_command",
    });
  });

  it("resolves exact local script contents", async () => {
    const sandbox = makeSandbox({
      "/home/user/scripts/test.sh": {
        type: "file",
        size: 34,
        content: "#!/bin/sh\npnpm exec jest --runInBand\n",
      },
    });
    await expect(
      collectAgentAutoReviewTerminalInspection({
        command: "bash scripts/test.sh",
        sandbox,
      }),
    ).resolves.toMatchObject({
      kind: "script",
      status: "resolved",
      scripts: [
        {
          source: "file",
          path: "/home/user/scripts/test.sh",
          content: "#!/bin/sh\npnpm exec jest --runInBand\n",
        },
      ],
    });
  });

  it("resolves package lifecycle scripts without sending the full package file", async () => {
    const packageJson = JSON.stringify({
      name: "example",
      scripts: {
        pretest: "echo preparing tests",
        test: "jest --runInBand",
        posttest: "echo tests complete",
      },
    });
    const sandbox = makeSandbox({
      "/home/user/package.json": {
        type: "file",
        size: Buffer.byteLength(packageJson),
        content: packageJson,
      },
    });
    await expect(
      collectAgentAutoReviewTerminalInspection({
        command: "pnpm run test",
        sandbox,
      }),
    ).resolves.toMatchObject({
      kind: "package_task",
      status: "resolved",
      scripts: [
        { name: "pretest", command: "echo preparing tests" },
        { name: "test", command: "jest --runInBand" },
        { name: "posttest", command: "echo tests complete" },
      ],
    });
  });

  it("keeps package tasks with unresolved local-script indirection on the human path", async () => {
    const packageJson = JSON.stringify({
      scripts: { release: "bash ./scripts/release.sh" },
    });
    const sandbox = makeSandbox({
      "/home/user/package.json": {
        type: "file",
        size: Buffer.byteLength(packageJson),
        content: packageJson,
      },
    });
    await expect(
      collectAgentAutoReviewTerminalInspection({
        command: "pnpm release",
        sandbox,
      }),
    ).resolves.toMatchObject({
      kind: "package_task",
      status: "unresolved",
      reason: "nested_indirection",
    });
  });

  it("detects evidence changes before execution", async () => {
    const reviewed = await collectAgentAutoReviewTerminalInspection({
      command: "bash scripts/test.sh",
      sandbox: makeSandbox({
        "/home/user/scripts/test.sh": {
          type: "file",
          size: 7,
          content: "echo ok",
        },
      }),
    });
    const current = await collectAgentAutoReviewTerminalInspection({
      command: "bash scripts/test.sh",
      sandbox: makeSandbox({
        "/home/user/scripts/test.sh": {
          type: "file",
          size: 8,
          content: "echo bad",
        },
      }),
    });
    expect(terminalInspectionMatches({ reviewed, current })).toBe(false);
    expect(terminalInspectionMatches({ reviewed, current: reviewed })).toBe(
      true,
    );
  });
});
