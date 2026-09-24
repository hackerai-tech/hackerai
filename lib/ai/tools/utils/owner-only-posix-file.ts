import { randomUUID } from "node:crypto";
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

const secureDirectoriesScript = (root: string, directory: string): string => `
set -eu
umask 077
secure_dir() {
  candidate="$1"
  if [ -L "$candidate" ]; then exit 73; fi
  if [ ! -e "$candidate" ]; then mkdir -m 700 "$candidate"; fi
  if [ ! -d "$candidate" ] || [ ! -O "$candidate" ]; then exit 73; fi
  chmod 700 "$candidate"
}
secure_dir ${quote(root)}
secure_dir ${quote(directory)}
`;

const runChecked = async (
  sandbox: LocalPosixSandbox,
  command: string,
  stdin?: string | Buffer,
): Promise<string> => {
  // The local client advertises this capability only after atomically
  // creating or opening both fixed /tmp roots with O_NOFOLLOW and confirming
  // ownership. The sticky /tmp parent then prevents a different UID from
  // replacing those trust anchors between these pathname-based operations.
  if (
    typeof sandbox.supportsCommandStdin !== "function" ||
    !sandbox.supportsCommandStdin()
  ) {
    throw new Error(
      "Private terminal artifact storage requires an updated HackerAI local client",
    );
  }
  const result = await sandbox.commands.run(command, {
    timeoutMs: COMMAND_TIMEOUT_MS,
    displayName: "",
    ...(stdin !== undefined ? { stdin } : {}),
  });
  if (result.exitCode !== 0) {
    throw Object.assign(
      new Error("Private terminal artifact operation failed"),
      {
        exitCode: result.exitCode,
      },
    );
  }
  return result.stdout;
};

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

  await runChecked(
    sandbox,
    `${secureDirectoriesScript(root, directory)}
if [ -L ${encodedFilePath} ]; then exit 73; fi
if [ -e ${encodedFilePath} ] && { [ ! -f ${encodedFilePath} ] || [ ! -O ${encodedFilePath} ]; }; then exit 73; fi
if [ -e ${encodedTemporaryPath} ] || [ -L ${encodedTemporaryPath} ]; then exit 73; fi
( set -C; : > ${encodedTemporaryPath} )
chmod 600 ${encodedTemporaryPath}
`,
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
    );
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
