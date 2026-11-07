import {
  classifyPersistenceFailure,
  persistenceCommandError,
  PersistenceError,
  type PrivateArtifactWritePhase,
} from "./persistence-failure";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { AnySandbox } from "@/types";
import { isCentrifugoSandbox } from "./sandbox-types";

const WRITE_CHUNK_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

type LocalPosixSandbox = Extract<
  AnySandbox,
  { readonly sandboxKind: "centrifugo" }
>;

const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const validatePaths = (
  root: string,
  directory: string,
  filePath?: string,
): void => {
  const normalizedRoot = path.posix.normalize(root);
  const normalizedDirectory = path.posix.normalize(directory);
  if (
    !normalizedRoot.startsWith("/tmp/") ||
    normalizedRoot !== root ||
    path.posix.dirname(normalizedDirectory) !== normalizedRoot ||
    normalizedDirectory !== directory
  ) {
    throw new Error("Invalid private terminal artifact path");
  }
  if (
    filePath !== undefined &&
    (path.posix.dirname(path.posix.normalize(filePath)) !==
      normalizedDirectory ||
      path.posix.normalize(filePath) !== filePath)
  ) {
    throw new Error("Invalid private terminal artifact file path");
  }
};

/** Preserve private-directory guards and report only fixed prepare stages on failure. */
const secureDirectoriesScript = (
  root: string,
  directory: string,
  diagnosePrepare = false,
): string => `
set -eu
umask 077
${
  diagnosePrepare
    ? `private_prepare_step=root_validate
trap 'private_prepare_status=$?; if [ "$private_prepare_status" -ne 0 ]; then printf "HA_PRIVATE_PREPARE:%s\\n" "$private_prepare_step" >&2 || :; fi; exit "$private_prepare_status"' EXIT`
    : ""
}
secure_dir() {
  candidate="$1"
  ${diagnosePrepare ? 'private_prepare_step="${2}_validate"' : ""}
  if [ -L "$candidate" ]; then exit 73; fi
  if [ ! -e "$candidate" ]; then
    ${diagnosePrepare ? 'private_prepare_step="${2}_mkdir"' : ""}
    mkdir -m 700 "$candidate"
  fi
  ${diagnosePrepare ? 'private_prepare_step="${2}_validate"' : ""}
  if [ ! -d "$candidate" ] || [ ! -O "$candidate" ]; then exit 73; fi
  ${diagnosePrepare ? 'private_prepare_step="${2}_chmod"' : ""}
  chmod 700 "$candidate"
}
secure_dir ${quote(root)}${diagnosePrepare ? " root" : ""}
secure_dir ${quote(directory)}${diagnosePrepare ? " directory" : ""}
`;

const runChecked = async (
  sandbox: LocalPosixSandbox,
  command: string,
  stdin?: string | Buffer,
  timeoutMs = COMMAND_TIMEOUT_MS,
  writePhase?: PrivateArtifactWritePhase,
): Promise<string> => {
  // The local client advertises this capability only after atomically
  // creating or opening both selected /tmp roots with O_NOFOLLOW and confirming
  // ownership. The sticky /tmp parent then prevents a different UID from
  // replacing those trust anchors between these pathname-based operations.
  if (
    typeof sandbox.supportsCommandStdin !== "function" ||
    !sandbox.supportsCommandStdin()
  ) {
    // Current POSIX clients explicitly advertise false when their private
    // storage preparation fails. An absent capability can be an older client;
    // neither case establishes that upgrading will repair filesystem state.
    if (sandbox.getConnectionInfo?.().capabilities?.commandStdin === false) {
      throw new PersistenceError(
        "Private terminal artifact storage is unavailable on this connection. Check the local client's startup storage diagnostics, resolve the reported ownership or filesystem problem, then restart the client. Do not use sudo or remove another user's files to bypass the checks.",
        "private_storage_unavailable",
      );
    }
    throw new Error(
      "Private terminal artifact storage requires an updated HackerAI local client",
    );
  }
  const result = await sandbox.commands.run(command, {
    timeoutMs,
    displayName: "",
    ...(stdin !== undefined ? { stdin } : {}),
  });
  if (result.exitCode !== 0) {
    throw persistenceCommandError(
      "Private terminal artifact operation failed",
      result,
      true,
      writePhase,
    );
  }
  return result.stdout;
};

/** Selects the hardened fallback only for non-native POSIX local relays. */
export function usesOwnerOnlyPosixFileTransport(
  sandbox: AnySandbox,
): sandbox is LocalPosixSandbox {
  if (!isCentrifugoSandbox(sandbox)) return false;
  const isWindows =
    typeof sandbox.isWindows === "function" && sandbox.isWindows();
  const hasNativeFileRelay =
    typeof sandbox.supportsNativeFileRelay === "function" &&
    sandbox.supportsNativeFileRelay();
  return !isWindows && !hasNativeFileRelay;
}

/**
 * Atomically replaces one private artifact through an owner-only temporary
 * file. Payload bytes travel over command stdin and never enter shell argv.
 */
export async function writeOwnerOnlyPosixFile(
  sandbox: LocalPosixSandbox,
  root: string,
  directory: string,
  filePath: string,
  content: string | Buffer,
): Promise<void> {
  validatePaths(root, directory, filePath);
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  const encodedFilePath = quote(filePath);
  const encodedTemporaryPath = quote(temporaryPath);

  // A lost command reply is not evidence that its stdin write failed. Verify
  // the exact bytes through a bounded read-only probe; never append them twice.
  const verifyAfterTimeout = async (
    error: unknown,
    target: string,
    expected: Buffer,
    stage: "append" | "commit",
  ): Promise<void> => {
    if (classifyPersistenceFailure(error) !== "timeout") throw error;
    try {
      const digest = await runChecked(
        sandbox,
        `
set -eu
for candidate in ${quote(root)} ${quote(directory)}; do
  [ ! -L "$candidate" ] && [ -d "$candidate" ] && [ -O "$candidate" ] || exit 73
done
[ ! -L ${quote(target)} ] && [ -f ${quote(target)} ] && [ -O ${quote(target)} ] || exit 73
${stage === "commit" ? `[ ! -e ${encodedTemporaryPath} ] && [ ! -L ${encodedTemporaryPath} ] || exit 73` : ""}
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum < ${quote(target)}
else
  shasum -a 256 < ${quote(target)}
fi
`,
        undefined,
        5000,
      );
      if (
        digest.trim().split(/\s+/)[0] !==
        createHash("sha256").update(expected).digest("hex")
      )
        throw error;
    } catch {
      throw error;
    }
    console.info(
      JSON.stringify({
        event: "local_private_artifact_write_recovered",
        stage,
      }),
    );
  };

  await runChecked(
    sandbox,
    `${secureDirectoriesScript(root, directory, true)}
private_prepare_step=target_validate
if [ -L ${encodedFilePath} ]; then exit 73; fi
if [ -e ${encodedFilePath} ] && { [ ! -f ${encodedFilePath} ] || [ ! -O ${encodedFilePath} ]; }; then exit 73; fi
private_prepare_step=temporary_validate
if [ -e ${encodedTemporaryPath} ] || [ -L ${encodedTemporaryPath} ]; then exit 73; fi
private_prepare_step=temporary_create
( set -C; : > ${encodedTemporaryPath} )
private_prepare_step=temporary_chmod
chmod 600 ${encodedTemporaryPath}
`,
    undefined,
    COMMAND_TIMEOUT_MS,
    "prepare",
  );

  try {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_BYTES) {
      await runChecked(
        sandbox,
        `${secureDirectoriesScript(root, directory)}
if [ -L ${encodedTemporaryPath} ] || [ ! -f ${encodedTemporaryPath} ] || [ ! -O ${encodedTemporaryPath} ]; then exit 73; fi
cat >> ${encodedTemporaryPath}
`,
        bytes.subarray(offset, offset + WRITE_CHUNK_BYTES),
        COMMAND_TIMEOUT_MS,
        "append",
      ).catch((error) =>
        verifyAfterTimeout(
          error,
          temporaryPath,
          bytes.subarray(0, offset + WRITE_CHUNK_BYTES),
          "append",
        ),
      );
    }

    await runChecked(
      sandbox,
      `${secureDirectoriesScript(root, directory)}
if [ -L ${encodedTemporaryPath} ] || [ ! -f ${encodedTemporaryPath} ] || [ ! -O ${encodedTemporaryPath} ]; then exit 73; fi
if [ -L ${encodedFilePath} ]; then exit 73; fi
if [ -e ${encodedFilePath} ] && { [ ! -f ${encodedFilePath} ] || [ ! -O ${encodedFilePath} ]; }; then exit 73; fi
chmod 600 ${encodedTemporaryPath}
mv -f ${encodedTemporaryPath} ${encodedFilePath}
chmod 600 ${encodedFilePath}
`,
      undefined,
      COMMAND_TIMEOUT_MS,
      "commit",
    ).catch((error) => verifyAfterTimeout(error, filePath, bytes, "commit"));
  } catch (error) {
    await sandbox.commands
      .run(
        `if [ -f ${encodedTemporaryPath} ] && [ ! -L ${encodedTemporaryPath} ] && [ -O ${encodedTemporaryPath} ]; then rm -f ${encodedTemporaryPath}; fi`,
        { timeoutMs: 5_000, displayName: "" },
      )
      .catch(() => undefined);
    throw error;
  }
}

/** Reads at most maxBytes after revalidating ownership, type, and permissions. */
export async function readOwnerOnlyPosixFile(
  sandbox: LocalPosixSandbox,
  root: string,
  directory: string,
  filePath: string,
  maxBytes: number,
): Promise<string> {
  validatePaths(root, directory, filePath);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Invalid private terminal artifact read limit");
  }
  const encodedFilePath = quote(filePath);
  return runChecked(
    sandbox,
    `${secureDirectoriesScript(root, directory)}
if [ -L ${encodedFilePath} ] || [ ! -f ${encodedFilePath} ] || [ ! -O ${encodedFilePath} ]; then exit 73; fi
chmod 600 ${encodedFilePath}
head -c ${maxBytes} ${encodedFilePath}
`,
  );
}

/** Lists direct children only after revalidating both private directories. */
export async function listOwnerOnlyPosixFiles(
  sandbox: LocalPosixSandbox,
  root: string,
  directory: string,
): Promise<Array<{ name: string }>> {
  validatePaths(root, directory);
  const output = await runChecked(
    sandbox,
    `${secureDirectoriesScript(root, directory)}
for entry in ${quote(directory)}/*; do
  if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi
  printf '%s\\n' "\${entry##*/}"
done
`,
  );
  return output
    .split("\n")
    .filter(Boolean)
    .map((name) => ({ name }));
}

/** Removes one owner-controlled regular file without following symlinks. */
export async function removeOwnerOnlyPosixFile(
  sandbox: LocalPosixSandbox,
  root: string,
  directory: string,
  filePath: string,
): Promise<void> {
  validatePaths(root, directory, filePath);
  const encodedFilePath = quote(filePath);
  await runChecked(
    sandbox,
    `${secureDirectoriesScript(root, directory)}
if [ ! -e ${encodedFilePath} ] && [ ! -L ${encodedFilePath} ]; then exit 0; fi
if [ -L ${encodedFilePath} ] || [ ! -f ${encodedFilePath} ] || [ ! -O ${encodedFilePath} ]; then exit 73; fi
rm -f ${encodedFilePath}
`,
  );
}
