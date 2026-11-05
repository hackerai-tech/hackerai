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
    ["pnpm install", "package_task"],
    ["npm --prefix ./pkg run test", "package_task"],
    ["env bash scripts/link.sh", "script"],
    ["env ./scripts/link.sh", "script"],
    ["env -S 'bash scripts/link.sh'", "script"],
    ["timeout 10 ./scripts/link.sh", "script"],
    ["node --version", null],
    ["python3 --version", null],
    ["pnpm --version", null],
    ["bash -v scripts/link.sh", "script"],
    ["python3 -v x.py", "script"],
    ["env bash -v scripts/link.sh", "script"],
    ["bash -v scripts/link.sh && echo done", "script"],
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

  it("keeps a regular local script on the human path without reading it", async () => {
    const sandbox = makeSandbox({
      "/home/user/scripts/test.sh": {
        type: "file",
        size: 34,
        content: "#!/bin/sh\npnpm exec jest --runInBand\n",
      },
    });
    const inspection = await collectAgentAutoReviewTerminalInspection({
      command: "bash scripts/test.sh",
      sandbox,
    });
    expect(inspection).toMatchObject({
      kind: "script",
      status: "unresolved",
      reason: "inspection_failed",
    });
    expect(inspection?.scripts).toBeUndefined();
    expect(sandbox.files.read).not.toHaveBeenCalled();
  });

  it.each(["bash scripts/link.sh", "pnpm run test"])(
    "does not send native local file contents for %s to auto-review",
    async (command) => {
      const readText = jest.fn(async () => ({
        content: "HOST_SECRET",
        sizeBytes: 11,
        tooLarge: false,
        truncated: false,
      }));
      const sandbox = {
        sandboxKind: "centrifugo",
        getWorkingDirectory: () => "/home/user",
        isWindows: () => false,
        supportsNativeFileRelay: () => true,
        files: { readText },
      } as unknown as AnySandbox;

      const inspection = await collectAgentAutoReviewTerminalInspection({
        command,
        sandbox,
      });

      expect(inspection).toMatchObject({ status: "unresolved" });
      expect(inspection?.scripts).toBeUndefined();
      expect(readText).not.toHaveBeenCalled();
    },
  );

  it("does not follow a cloud script's symlinked parent into sensitive content", async () => {
    const sandbox = makeSandbox({
      "/home/user/scripts": {
        type: "symlink",
        symlinkTarget: "/home/user/.env",
      },
      "/home/user/scripts/link.sh": {
        type: "file",
        size: 11,
        content: "CLOUD_SECRET",
      },
    });

    const inspection = await collectAgentAutoReviewTerminalInspection({
      command: "bash scripts/link.sh",
      sandbox,
    });

    expect(inspection).toMatchObject({ status: "unresolved" });
    expect(inspection?.scripts).toBeUndefined();
    expect(sandbox.files.read).not.toHaveBeenCalled();
  });

  it("keeps package lifecycle scripts on the human path without reading package.json", async () => {
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
    const inspection = await collectAgentAutoReviewTerminalInspection({
      command: "pnpm run test",
      sandbox,
    });
    expect(inspection).toMatchObject({
      kind: "package_task",
      status: "unresolved",
      reason: "inspection_failed",
    });
    expect(inspection?.scripts).toBeUndefined();
    expect(sandbox.files.read).not.toHaveBeenCalled();
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
      reason: "inspection_failed",
    });
  });

  it("detects evidence changes before execution", async () => {
    const reviewed = await collectAgentAutoReviewTerminalInspection({
      command: "rm -rf build",
      sandbox: makeSandbox({
        "/home/user/build": {
          type: "file",
          size: 7,
        },
      }),
    });
    const current = await collectAgentAutoReviewTerminalInspection({
      command: "rm -rf build",
      sandbox: makeSandbox({
        "/home/user/build": {
          type: "file",
          size: 8,
        },
      }),
    });
    expect(terminalInspectionMatches({ reviewed, current })).toBe(false);
    expect(terminalInspectionMatches({ reviewed, current: reviewed })).toBe(
      true,
    );
  });
});
