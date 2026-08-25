import "server-only";

import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import type { AwsLambdaMicrovmRegion } from "./aws-lambda-microvm-release";

const WORKSPACE_ROOT = "/home/user";
const WORKSPACE_READY_MARKER = "/tmp/.hackerai-workspace-v1.ready";
const WORKSPACE_FAILED_MARKER = "/tmp/.hackerai-workspace-v1.failed";
const WORKSPACE_RESTORE_LOCK = "/tmp/.hackerai-workspace-v1.lock";
const WORKSPACE_SNAPSHOT_LOCK = "/tmp/.hackerai-workspace-v1.snapshot.lock";
const WORKSPACE_UPLOAD_URL_FILE = "/tmp/.hackerai-workspace-v1.upload-url";
const WORKSPACE_CHECKPOINT_SCRIPT = "/tmp/.hackerai-workspace-v1-checkpoint.sh";
const WORKSPACE_CHECKPOINT_PID = "/tmp/.hackerai-workspace-v1-checkpoint.pid";
const WORKSPACE_CHECKPOINT_START_LOCK =
  "/tmp/.hackerai-workspace-v1-checkpoint-start.lock";
const WORKSPACE_CHECKPOINT_FINGERPRINT =
  "/tmp/.hackerai-workspace-v1-checkpoint.fingerprint";
const WORKSPACE_ACTIVE_CHECKPOINT_INTERVAL_SECONDS = 5 * 60;
const WORKSPACE_QUIET_CHECKPOINT_INTERVAL_SECONDS = 10 * 60;
const WORKSPACE_CHECKPOINT_FINGERPRINT_TIMEOUT_SECONDS = 10;
const WORKSPACE_CHECKPOINT_TAR_TIMEOUT_SECONDS = 45;
const WORKSPACE_CHECKPOINT_UPLOAD_TIMEOUT_SECONDS = 50;
const WORKSPACE_CHECKPOINT_CONNECT_TIMEOUT_SECONDS = 15;
const WORKSPACE_TRANSFER_TIMEOUT_MS = 10 * 60 * 1_000;
const WORKSPACE_TRANSFER_TIMEOUT_SECONDS = Math.ceil(
  WORKSPACE_TRANSFER_TIMEOUT_MS / 1_000,
);
const WORKSPACE_RESTORE_WAIT_ATTEMPTS = WORKSPACE_TRANSFER_TIMEOUT_SECONDS;
const WORKSPACE_RESTORE_COMMAND_TIMEOUT_MS =
  WORKSPACE_TRANSFER_TIMEOUT_MS + 30_000;

type WorkspaceSandbox = {
  commands: {
    run: (
      command: string,
      options?: { timeoutMs?: number; displayName?: string },
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
};

type WorkspaceRestoreStage =
  | "get_download_url"
  | "restore_archive"
  | "get_upload_url"
  | "start_checkpoint";

export class AwsLambdaMicrovmWorkspaceRestoreError extends Error {
  readonly workspaceRestoreStage: WorkspaceRestoreStage;

  constructor(stage: WorkspaceRestoreStage, cause: unknown) {
    super(`Cloud workspace restore failed during ${stage}`, { cause });
    this.name = "AwsLambdaMicrovmWorkspaceRestoreError";
    this.workspaceRestoreStage = stage;
  }
}

async function runRestoreStage<T>(
  stage: WorkspaceRestoreStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AwsLambdaMicrovmWorkspaceRestoreError) throw error;
    throw new AwsLambdaMicrovmWorkspaceRestoreError(stage, error);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function workspaceFingerprintCommand(): string {
  return [
    `(cd ${shellQuote(WORKSPACE_ROOT)} && find . \\`,
    "  \\( -path './.cache' -o -path './.npm/_cacache' -o -path './.local/share/pnpm/store' -o -name node_modules \\) -prune -o " +
      "\\",
    "  -printf '%P\\0%y\\0%s\\0%T@\\0%l\\0' | LC_ALL=C sort -z | sha256sum | cut -d' ' -f1)",
  ].join("\n");
}

function boundedWorkspaceFingerprintCommand(): string {
  return [
    "timeout",
    "--signal=TERM",
    "--kill-after=2s",
    `${WORKSPACE_CHECKPOINT_FINGERPRINT_TIMEOUT_SECONDS}s`,
    "/bin/bash",
    "-c",
    shellQuote(`set -euo pipefail; ${workspaceFingerprintCommand()}`),
  ].join(" ");
}

function transferError(
  operation: "restore" | "snapshot" | "checkpoint",
  exitCode: number,
) {
  return new Error(
    `Cloud workspace ${operation} failed with exit code ${exitCode}`,
  );
}

export function buildWorkspaceRestoreCommand(downloadUrl: string | null) {
  const restore = downloadUrl
    ? [
        'archive="$(mktemp /tmp/hackerai-workspace.XXXXXX.tar.gz)"',
        "trap 'rm -f \"$archive\"' EXIT",
        `curl --fail --silent --show-error --location --retry 3 --retry-all-errors --output "$archive" ${shellQuote(downloadUrl)}`,
        'tar -tzf "$archive" >/dev/null',
        `tar -xzf "$archive" -C ${shellQuote(WORKSPACE_ROOT)} --no-same-owner --no-same-permissions`,
      ].join("; ")
    : "true";
  const boundedRestore = [
    "timeout",
    "--signal=TERM",
    "--kill-after=5s",
    `${WORKSPACE_TRANSFER_TIMEOUT_SECONDS}s`,
    "/bin/bash",
    "-c",
    shellQuote(`set -eu; ${restore}`),
  ].join(" ");

  return [
    "set -eu",
    `ready=${shellQuote(WORKSPACE_READY_MARKER)}`,
    `failed=${shellQuote(WORKSPACE_FAILED_MARKER)}`,
    `lock=${shellQuote(WORKSPACE_RESTORE_LOCK)}`,
    '[ -f "$ready" ] && exit 0',
    'if mkdir "$lock" 2>/dev/null; then',
    "  trap 'rmdir \"$lock\" 2>/dev/null || true' EXIT",
    '  rm -f "$failed"',
    `  mkdir -p ${shellQuote(WORKSPACE_ROOT)}`,
    `  if ! ${boundedRestore}; then touch "$failed"; exit 70; fi`,
    '  touch "$ready"',
    "else",
    "  attempts=0",
    '  while [ ! -f "$ready" ]; do',
    '    [ -f "$failed" ] && exit 70',
    "    attempts=$((attempts + 1))",
    `    [ "$attempts" -gt ${WORKSPACE_RESTORE_WAIT_ATTEMPTS} ] && exit 71`,
    "    sleep 1",
    "  done",
    "fi",
  ].join("\n");
}

export function buildWorkspaceSnapshotCommand(uploadUrl: string) {
  return [
    "set -eu;",
    `exec 9>${shellQuote(WORKSPACE_SNAPSHOT_LOCK)};`,
    "flock -w 120 9;",
    'archive="$(mktemp /tmp/hackerai-workspace.XXXXXX.tar.gz)";',
    "trap 'rm -f \"$archive\"' EXIT;",
    "tar_status=0;",
    'tar --create --gzip --file="$archive"',
    `--directory=${shellQuote(WORKSPACE_ROOT)}`,
    "--warning=no-file-changed",
    "--exclude='./.cache'",
    "--exclude='./.npm/_cacache'",
    "--exclude='./.local/share/pnpm/store'",
    "--exclude='*/node_modules'",
    ". || tar_status=$?;",
    '[ "$tar_status" -le 1 ];',
    "curl --fail --silent --show-error --retry 3 --retry-all-errors",
    '--request PUT --upload-file "$archive"',
    shellQuote(uploadUrl),
  ].join(" ");
}

export function buildWorkspaceCheckpointScript() {
  return [
    "#!/bin/bash",
    `interval=${WORKSPACE_ACTIVE_CHECKPOINT_INTERVAL_SECONDS}`,
    "workspace_fingerprint() {",
    `  ${boundedWorkspaceFingerprintCommand()}`,
    "}",
    "while true; do",
    '  sleep "$interval"',
    "  (",
    "    set -eu",
    "    flock -n 9 || exit 11",
    '    fingerprint="$(workspace_fingerprint)"',
    `    fingerprint_file=${shellQuote(WORKSPACE_CHECKPOINT_FINGERPRINT)}`,
    '    if [ -r "$fingerprint_file" ] && [ "$(cat "$fingerprint_file")" = "$fingerprint" ]; then exit 10; fi',
    '    archive="$(mktemp /tmp/hackerai-workspace.XXXXXX.tar.gz)"',
    '    fingerprint_tmp="${fingerprint_file}.$$"',
    '    trap \'rm -f "$archive" "$fingerprint_tmp"\' EXIT',
    "    tar_status=0",
    `    timeout --signal=TERM --kill-after=5s ${WORKSPACE_CHECKPOINT_TAR_TIMEOUT_SECONDS}s tar --create --gzip --file="$archive" --directory=${shellQuote(WORKSPACE_ROOT)} --warning=no-file-changed --exclude='./.cache' --exclude='./.npm/_cacache' --exclude='./.local/share/pnpm/store' --exclude='*/node_modules' . || tar_status=$?`,
    '    [ "$tar_status" -le 1 ]',
    `    upload_url="$(cat ${shellQuote(WORKSPACE_UPLOAD_URL_FILE)})"`,
    `    timeout --signal=TERM --kill-after=5s ${WORKSPACE_CHECKPOINT_UPLOAD_TIMEOUT_SECONDS}s curl --fail --silent --show-error --connect-timeout ${WORKSPACE_CHECKPOINT_CONNECT_TIMEOUT_SECONDS} --max-time ${WORKSPACE_CHECKPOINT_UPLOAD_TIMEOUT_SECONDS} --retry 3 --retry-all-errors --request PUT --upload-file "$archive" "$upload_url"`,
    '    printf \'%s\\n\' "$fingerprint" > "$fingerprint_tmp"',
    '    mv "$fingerprint_tmp" "$fingerprint_file"',
    `  ) 9>${shellQuote(WORKSPACE_SNAPSHOT_LOCK)}`,
    '  checkpoint_status="$?"',
    '  if [ "$checkpoint_status" -eq 0 ]; then',
    `    interval=${WORKSPACE_ACTIVE_CHECKPOINT_INTERVAL_SECONDS}`,
    '  elif [ "$checkpoint_status" -eq 10 ]; then',
    `    interval=${WORKSPACE_QUIET_CHECKPOINT_INTERVAL_SECONDS}`,
    "  else",
    `    interval=${WORKSPACE_ACTIVE_CHECKPOINT_INTERVAL_SECONDS}`,
    "  fi",
    "done",
  ].join("\n");
}

export function buildWorkspaceCheckpointCommand(uploadUrl: string) {
  const checkpointScript = buildWorkspaceCheckpointScript();
  return [
    "set -eu",
    "umask 077",
    `url_file=${shellQuote(WORKSPACE_UPLOAD_URL_FILE)}`,
    `script=${shellQuote(WORKSPACE_CHECKPOINT_SCRIPT)}`,
    `pid_file=${shellQuote(WORKSPACE_CHECKPOINT_PID)}`,
    `fingerprint_file=${shellQuote(WORKSPACE_CHECKPOINT_FINGERPRINT)}`,
    'url_tmp="${url_file}.$$"',
    `printf '%s' ${shellQuote(uploadUrl)} > "$url_tmp"`,
    'mv "$url_tmp" "$url_file"',
    `if [ ! -r "$fingerprint_file" ] && fingerprint="$(${boundedWorkspaceFingerprintCommand()})"; then`,
    '  fingerprint_tmp="${fingerprint_file}.$$"',
    '  printf \'%s\\n\' "$fingerprint" > "$fingerprint_tmp"',
    '  mv "$fingerprint_tmp" "$fingerprint_file"',
    "fi",
    'if [ ! -x "$script" ]; then',
    '  script_tmp="${script}.$$"',
    `  printf '%s\n' ${shellQuote(checkpointScript)} > "$script_tmp"`,
    '  chmod 700 "$script_tmp"',
    '  mv "$script_tmp" "$script"',
    "fi",
    `exec 8>${shellQuote(WORKSPACE_CHECKPOINT_START_LOCK)}`,
    "flock -w 10 8",
    'if [ -r "$pid_file" ]; then',
    '  checkpoint_pid="$(cat "$pid_file")"',
    '  if kill -0 "$checkpoint_pid" 2>/dev/null && tr \'\\0\' \' \' < "/proc/$checkpoint_pid/cmdline" | grep -Fq -- "$script"; then exit 0; fi',
    "fi",
    'nohup /bin/bash -c \'exec 8>&-; exec /bin/bash "$1"\' _ "$script" >/dev/null 2>&1 </dev/null &',
    'printf \'%s\n\' "$!" > "$pid_file"',
  ].join("\n");
}

export async function restoreAwsLambdaMicrovmWorkspace(args: {
  userId: string;
  serviceKey: string;
  region: AwsLambdaMicrovmRegion;
  sandbox: WorkspaceSandbox;
}): Promise<{ snapshotAvailable: boolean }> {
  const downloadUrl = await runRestoreStage("get_download_url", () =>
    getConvexClient().action(
      api.s3Actions.getMicrovmWorkspaceDownloadUrlAction,
      {
        serviceKey: args.serviceKey,
        userId: args.userId,
        region: args.region,
      },
    ),
  );
  await runRestoreStage("restore_archive", async () => {
    const result = await args.sandbox.commands.run(
      buildWorkspaceRestoreCommand(downloadUrl),
      { timeoutMs: WORKSPACE_RESTORE_COMMAND_TIMEOUT_MS, displayName: "" },
    );
    if (result.exitCode !== 0) throw transferError("restore", result.exitCode);
  });

  const uploadUrl = await runRestoreStage("get_upload_url", () =>
    getConvexClient().action(
      api.s3Actions.generateMicrovmWorkspaceUploadUrlAction,
      {
        serviceKey: args.serviceKey,
        userId: args.userId,
        region: args.region,
      },
    ),
  );
  await runRestoreStage("start_checkpoint", async () => {
    const checkpointResult = await args.sandbox.commands.run(
      buildWorkspaceCheckpointCommand(uploadUrl),
      { timeoutMs: WORKSPACE_TRANSFER_TIMEOUT_MS, displayName: "" },
    );
    if (checkpointResult.exitCode !== 0) {
      throw transferError("checkpoint", checkpointResult.exitCode);
    }
  });
  return { snapshotAvailable: downloadUrl !== null };
}

export async function snapshotAwsLambdaMicrovmWorkspace(args: {
  userId: string;
  serviceKey: string;
  region: AwsLambdaMicrovmRegion;
  sandbox: WorkspaceSandbox;
}): Promise<void> {
  const uploadUrl = await getConvexClient().action(
    api.s3Actions.generateMicrovmWorkspaceUploadUrlAction,
    {
      serviceKey: args.serviceKey,
      userId: args.userId,
      region: args.region,
    },
  );
  const result = await args.sandbox.commands.run(
    buildWorkspaceSnapshotCommand(uploadUrl),
    { timeoutMs: WORKSPACE_TRANSFER_TIMEOUT_MS, displayName: "" },
  );
  if (result.exitCode !== 0) throw transferError("snapshot", result.exitCode);
}

export async function deleteAwsLambdaMicrovmWorkspace(
  userId: string,
  serviceKey: string,
): Promise<void> {
  await getConvexClient().action(api.s3Actions.deleteMicrovmWorkspaceAction, {
    serviceKey,
    userId,
  });
}
