jest.mock("server-only", () => ({}), { virtual: true });

const mockAction = jest.fn();

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ action: mockAction }),
}));

import {
  buildWorkspaceCheckpointCommand,
  buildWorkspaceCheckpointScript,
  buildWorkspaceRestoreCommand,
  buildWorkspaceSnapshotCommand,
  deleteAwsLambdaMicrovmWorkspace,
  restoreAwsLambdaMicrovmWorkspace,
  snapshotAwsLambdaMicrovmWorkspace,
} from "../aws-lambda-microvm-workspace";
import { spawnSync } from "node:child_process";

describe("AWS Lambda MicroVM durable workspace", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("restores an existing archive through a validated temporary file", async () => {
    const run = jest.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    mockAction.mockResolvedValue(
      "https://s3.example/download?signature=secret",
    );

    await expect(
      restoreAwsLambdaMicrovmWorkspace({
        userId: "user_123",
        serviceKey: "service-key",
        region: "us-west-2",
        sandbox: { commands: { run } },
      }),
    ).resolves.toEqual({ snapshotAvailable: true });

    const command = run.mock.calls[0][0] as string;
    expect(command).toContain("mktemp /tmp/hackerai-workspace");
    expect(command.indexOf('tar -tzf "$archive"')).toBeLessThan(
      command.indexOf('tar -xzf "$archive"'),
    );
    expect(command).toContain("/home/user");
    expect(command).toContain(".hackerai-workspace-v1.ready");
    expect(command).toContain(".hackerai-workspace-v1.lock");
    expect(command.match(/rmdir/g)).toHaveLength(1);
    expect(command).toContain('[ "$attempts" -gt 600 ] && exit 71');
    expect(command).toContain("--kill-after=5s 600s /bin/bash -c");
    expect(run.mock.calls[0][1]).toEqual({
      timeoutMs: 630_000,
      displayName: "",
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(mockAction).toHaveBeenNthCalledWith(1, expect.anything(), {
      serviceKey: "service-key",
      userId: "user_123",
      region: "us-west-2",
    });
    expect(mockAction).toHaveBeenNthCalledWith(2, expect.anything(), {
      serviceKey: "service-key",
      userId: "user_123",
      region: "us-west-2",
    });
    const checkpointCommand = run.mock.calls[1][0] as string;
    expect(checkpointCommand).toContain("sleep 120");
    expect(checkpointCommand).toContain("nohup /bin/bash");
    expect(checkpointCommand).toContain("exec 8>&-");
  });

  it("marks a new workspace ready without making a download request", () => {
    const command = buildWorkspaceRestoreCommand(null);
    expect(command).not.toContain("curl ");
    expect(command).toContain('touch "$ready"');
  });

  it("snapshots source files while excluding rebuildable dependency caches", async () => {
    const run = jest.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    mockAction.mockResolvedValue("https://s3.example/upload?signature=secret");

    await snapshotAwsLambdaMicrovmWorkspace({
      userId: "user_123",
      serviceKey: "service-key",
      region: "eu-west-1",
      sandbox: { commands: { run } },
    });

    const command = run.mock.calls[0][0] as string;
    expect(command).toContain("set -eu;");
    expect(command).toContain("mktemp /tmp/hackerai-workspace");
    expect(command).toContain("--directory='/home/user'");
    expect(command).toContain("--exclude='*/node_modules'");
    expect(command).toContain("tar_status=0");
    expect(command).toContain('[ "$tar_status" -le 1 ]');
    expect(command).toContain('--upload-file "$archive"');
  });

  it("uploads a usable snapshot when GNU tar reports changed files", () => {
    const command = buildWorkspaceSnapshotCommand("https://s3.example/upload");
    const result = spawnSync(
      "bash",
      ["-c", `tar() { return 1; }; curl() { printf uploaded; }; ${command}`],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("uploaded");
  });

  it("does not upload a snapshot after a fatal tar error", () => {
    const command = buildWorkspaceSnapshotCommand("https://s3.example/upload");
    const result = spawnSync(
      "bash",
      ["-c", `tar() { return 2; }; curl() { printf uploaded; }; ${command}`],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("fails the lifecycle when a transfer command does not complete", async () => {
    const run = jest.fn().mockResolvedValue({
      stdout: "",
      stderr: "upload failed",
      exitCode: 22,
    });
    mockAction.mockResolvedValue("https://s3.example/upload");

    await expect(
      snapshotAwsLambdaMicrovmWorkspace({
        userId: "user_123",
        serviceKey: "service-key",
        region: "us-east-1",
        sandbox: { commands: { run } },
      }),
    ).rejects.toThrow("Cloud workspace snapshot failed with exit code 22");
  });

  it("deletes the durable object through the service-key action", async () => {
    mockAction.mockResolvedValue(null);
    await deleteAwsLambdaMicrovmWorkspace("user_123", "service-key");

    expect(mockAction).toHaveBeenCalledWith(expect.anything(), {
      serviceKey: "service-key",
      userId: "user_123",
    });
  });

  it("quotes apostrophes in signed URLs", () => {
    const command = buildWorkspaceSnapshotCommand(
      "https://s3.example/upload?value=a'b",
    );
    expect(command).toContain("a'\\''b'");
  });

  it("generates shell programs that pass Bash syntax validation", () => {
    for (const command of [
      buildWorkspaceRestoreCommand(null),
      buildWorkspaceRestoreCommand("https://s3.example/download"),
      buildWorkspaceSnapshotCommand("https://s3.example/upload"),
      buildWorkspaceCheckpointCommand("https://s3.example/upload"),
      buildWorkspaceCheckpointScript(),
    ]) {
      const result = spawnSync("bash", ["-n"], { input: command });
      expect(result.status).toBe(0);
    }
  });

  it("keeps fatal checkpoint tar errors from reaching the upload", () => {
    const script = buildWorkspaceCheckpointScript();
    expect(script).toContain("tar_status=0");
    expect(script).toContain("tar_status=$?");
    expect(script).toContain('[ "$tar_status" -le 1 ]');
  });

  it("bounds detached checkpoint work below the final snapshot lock wait", () => {
    const script = buildWorkspaceCheckpointScript();

    expect(script).toContain("timeout --signal=TERM --kill-after=5s 45s tar");
    expect(script).toContain("timeout --signal=TERM --kill-after=5s 50s curl");
    expect(script).toContain("--connect-timeout 15 --max-time 50");
    expect(45 + 5 + 50 + 5).toBeLessThan(120);
  });
});
