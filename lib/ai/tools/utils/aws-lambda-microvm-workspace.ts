import "server-only";

import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";

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
const WORKSPACE_CHECKPOINT_INTERVAL_SECONDS = 2 * 60;
const WORKSPACE_TRANSFER_TIMEOUT_MS = 10 * 60 * 1_000;
const WORKSPACE_RESTORE_WAIT_ATTEMPTS =
  Math.floor(WORKSPACE_TRANSFER_TIMEOUT_MS / 1_000) - 5;

type WorkspaceSandbox = {
  commands: {
    run: (
      command: string,
      options?: { timeoutMs?: number; displayName?: string },
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
    `  if ! ( ${restore} ); then touch "$failed"; exit 70; fi`,
    '  touch "$ready"',
    "else",
    "  attempts=0",
    '  while [ ! -f "$ready" ]; do',
    '    [ -f "$failed" ] && exit 70',
    "    attempts=$((attempts + 1))",
    `    [ "$attempts" -ge ${WORKSPACE_RESTORE_WAIT_ATTEMPTS} ] && exit 71`,
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
    "while true; do",
    `  sleep ${WORKSPACE_CHECKPOINT_INTERVAL_SECONDS}`,
    "  (",
    "    set -eu",
    "    flock -n 9 || exit 0",
    '    archive="$(mktemp /tmp/hackerai-workspace.XXXXXX.tar.gz)"',
    "    trap 'rm -f \"$archive\"' EXIT",
    "    tar_status=0",
    `    tar --create --gzip --file="$archive" --directory=${shellQuote(WORKSPACE_ROOT)} --warning=no-file-changed --exclude='./.cache' --exclude='./.npm/_cacache' --exclude='./.local/share/pnpm/store' --exclude='*/node_modules' . || tar_status=$?`,
    '    [ "$tar_status" -le 1 ]',
    `    upload_url="$(cat ${shellQuote(WORKSPACE_UPLOAD_URL_FILE)})"`,
    '    curl --fail --silent --show-error --retry 3 --retry-all-errors --request PUT --upload-file "$archive" "$upload_url"',
    `  ) 9>${shellQuote(WORKSPACE_SNAPSHOT_LOCK)} || true`,
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
    'url_tmp="${url_file}.$$"',
    `printf '%s' ${shellQuote(uploadUrl)} > "$url_tmp"`,
    'mv "$url_tmp" "$url_file"',
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
  sandbox: WorkspaceSandbox;
}): Promise<{ snapshotAvailable: boolean }> {
  const downloadUrl = await getConvexClient().action(
    api.s3Actions.getMicrovmWorkspaceDownloadUrlAction,
    { serviceKey: args.serviceKey, userId: args.userId },
  );
  const result = await args.sandbox.commands.run(
    buildWorkspaceRestoreCommand(downloadUrl),
    { timeoutMs: WORKSPACE_TRANSFER_TIMEOUT_MS, displayName: "" },
  );
  if (result.exitCode !== 0) throw transferError("restore", result.exitCode);

  const uploadUrl = await getConvexClient().action(
    api.s3Actions.generateMicrovmWorkspaceUploadUrlAction,
    { serviceKey: args.serviceKey, userId: args.userId },
  );
  const checkpointResult = await args.sandbox.commands.run(
    buildWorkspaceCheckpointCommand(uploadUrl),
    { timeoutMs: WORKSPACE_TRANSFER_TIMEOUT_MS, displayName: "" },
  );
  if (checkpointResult.exitCode !== 0) {
    throw transferError("checkpoint", checkpointResult.exitCode);
  }
  return { snapshotAvailable: downloadUrl !== null };
}

export async function snapshotAwsLambdaMicrovmWorkspace(args: {
  userId: string;
  serviceKey: string;
  sandbox: WorkspaceSandbox;
}): Promise<void> {
  const uploadUrl = await getConvexClient().action(
    api.s3Actions.generateMicrovmWorkspaceUploadUrlAction,
    { serviceKey: args.serviceKey, userId: args.userId },
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
