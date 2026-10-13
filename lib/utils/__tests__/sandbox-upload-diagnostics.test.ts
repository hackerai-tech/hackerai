jest.mock("server-only", () => ({}), { virtual: true });

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeSandboxUploadWrite } from "../sandbox-upload-diagnostics";

const validProbe = {
  probe_status: "ok",
  command_uid: 1000,
  command_gid: 1000,
  target_exists: true,
  target_uid: 0,
  target_mode: 0o400,
  target_writable: false,
  available_bytes: 1234,
  available_inodes: 100,
  filesystem_read_only: false,
  write_probe_result: "writable",
};

it("checks ownership and capacity without touching the attachment or retaining probe files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hackerai-upload-probe-"));
  const target = join(directory, "private '$() report.txt");
  writeFileSync(target, "private attachment content");
  chmodSync(target, 0o400);
  const run = jest.fn(async (command: string) => ({
    // The command runs under GNU timeout on E2B; execute just the same Python
    // probe locally so macOS test runners do not need GNU coreutils installed.
    stdout: execFileSync(
      "/bin/sh",
      ["-c", command.replace(/^timeout --kill-after=1s 3s /, "")],
      { encoding: "utf8", timeout: 4_000 },
    ),
    stderr: "",
    exitCode: 0,
  }));
  try {
    const sandbox = { commands: { run } } as any;
    const result = await probeSandboxUploadWrite(sandbox, target);
    expect(result).toMatchObject({
      probe_status: "ok",
      target_exists: true,
      target_type: "file",
      target_mode: 0o400,
      probe_directory_is_parent: true,
      write_probe_result: "writable",
    });
    expect(typeof result.command_uid).toBe("number");
    expect(typeof result.available_bytes).toBe("number");
    expect(typeof result.available_inodes).toBe("number");
    expect(JSON.stringify(result)).not.toMatch(
      /private|attachment|report|\/tmp|\/Users/,
    );
    expect(readFileSync(target, "utf8")).toBe("private attachment content");
    expect(readdirSync(directory)).toEqual(["private '$() report.txt"]);
    const missingParent = await probeSandboxUploadWrite(
      sandbox,
      join(directory, "missing", "file"),
    );
    expect(missingParent).toMatchObject({
      probe_status: "ok",
      target_exists: false,
      probe_directory_is_parent: false,
      write_probe_result: "writable",
    });
    expect(readdirSync(directory)).toHaveLength(1);
    expect(run.mock.calls[0][0]).toMatch(
      /^timeout --kill-after=1s 3s python3 /,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("allows only numeric, boolean and known categorical diagnostics from the sandbox", async () => {
  const run = jest.fn().mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({
      ...validProbe,
      target_type: "/private/customer.txt",
      available_inodes: "PRIVATE_CONTENT",
      directory_uid: -1,
      directory_gid: 1.5,
      filename: "secret",
      raw_stderr: "secret signed URL",
      constructor: "secret",
    }),
    stderr: "secret",
  });
  const result = await probeSandboxUploadWrite(
    { commands: { run } } as any,
    "/home/user/upload/private",
  );
  expect(result).toEqual(
    expect.objectContaining({
      probe_status: "ok",
      target_uid: 0,
      available_bytes: 1234,
      write_probe_result: "writable",
    }),
  );
  expect(JSON.stringify(result)).not.toMatch(
    /private|secret|PRIVATE|constructor/,
  );
  expect(result).not.toHaveProperty("target_type");
  expect(result).not.toHaveProperty("available_inodes");
  expect(result).not.toHaveProperty("directory_uid");
});

it.each([
  "invalid JSON",
  "[]",
  "null",
  '"secret"',
  JSON.stringify({ probe_status: "ok" }),
  "x".repeat(4097),
])("treats invalid probe output as unavailable", async (stdout) => {
  const run = jest.fn().mockResolvedValue({ stdout, stderr: "", exitCode: 0 });
  await expect(
    probeSandboxUploadWrite(
      { commands: { run } } as any,
      "/home/user/upload/file",
    ),
  ).resolves.toEqual({ probe_status: "unavailable" });
});

it("does not replace a transfer failure when the diagnostics command times out", async () => {
  const run = jest.fn().mockRejectedValue(new Error("command timed out"));
  await expect(
    probeSandboxUploadWrite(
      { commands: { run } } as any,
      "/home/user/upload/file",
    ),
  ).resolves.toEqual({ probe_status: "unavailable" });
});

it("propagates cancellation and disconnects the diagnostic process", async () => {
  const controller = new AbortController();
  const handle = {
    pid: 12,
    wait: jest.fn(async () => {
      controller.abort();
      return { stdout: "", stderr: "", exitCode: 0 };
    }),
    disconnect: jest.fn(),
  };
  const sandbox = {
    commands: {
      run: jest.fn(async () => handle),
      kill: jest.fn(async () => true),
    },
  };
  await expect(
    probeSandboxUploadWrite(
      sandbox as any,
      "/home/user/upload/file",
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(sandbox.commands.run).toHaveBeenCalledWith(expect.any(String), {
    displayName: "",
    timeoutMs: 4000,
    background: true,
    requestTimeoutMs: 10000,
  });
  expect(sandbox.commands.kill).toHaveBeenCalledWith(12, {
    requestTimeoutMs: 5000,
  });
  expect(handle.disconnect).toHaveBeenCalledTimes(1);
});
