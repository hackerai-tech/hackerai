import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommandIdentity } from "./command-identity";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_ROOTS = [
  "/tmp/terminal_execution_records",
  "/tmp/terminal_full_output",
];

const openDirectoryNoFollow = (directory: string) =>
  open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );

/** Opens and tightens a directory through the same no-follow file handle. */
const hardenOwnedDirectory = async (
  directory: string,
  uid: number,
): Promise<boolean> => {
  const handle = await openDirectoryNoFollow(directory);
  try {
    const stats = await handle.stat();
    if (!stats.isDirectory() || stats.uid !== uid) return false;
    await handle.chmod(0o700);
    return true;
  } finally {
    await handle.close();
  }
};

/** Atomically creates a missing root or validates an existing no-follow root. */
const claimOwnedRoot = async (root: string, uid: number): Promise<boolean> => {
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return hardenOwnedDirectory(root, uid);
};

/** Tightens an owned regular file through a no-follow file handle. */
const hardenOwnedFile = async (
  filePath: string,
  uid: number,
): Promise<void> => {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stats = await handle.stat();
    if (stats.isFile() && stats.uid === uid) await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
};

/**
 * Tighten permissions on artifacts created by older local clients. Every
 * filesystem object is opened without following symlinks before chmod.
 */
export async function hardenExistingTerminalArtifacts(
  roots: readonly string[] = DEFAULT_ROOTS,
): Promise<boolean> {
  if (os.platform() === "win32" || typeof process.getuid !== "function") {
    return false;
  }
  const uid = process.getuid();
  let rootsReady = true;

  for (const root of roots) {
    try {
      if (!(await claimOwnedRoot(root, uid))) {
        rootsReady = false;
        console.warn(
          `Private terminal artifact root ${root} is not an owned directory; this artifact root will not be used`,
        );
        continue;
      }
      const scopes = await readdir(root, { withFileTypes: true });
      for (const scope of scopes) {
        if (!scope.isDirectory() || scope.isSymbolicLink()) continue;
        const scopePath = path.join(root, scope.name);
        try {
          if (!(await hardenOwnedDirectory(scopePath, uid))) continue;
          const entries = await readdir(scopePath, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isFile() || entry.isSymbolicLink()) continue;
            try {
              await hardenOwnedFile(path.join(scopePath, entry.name), uid);
            } catch {
              // A concurrently replaced or inaccessible entry stays untouched.
            }
          }
        } catch {
          // Ignore unsafe or concurrently replaced scope directories.
        }
      }
    } catch (error) {
      rootsReady = false;
      const code = (error as NodeJS.ErrnoException)?.code;
      const reason = [
        "EACCES",
        "EPERM",
        "ELOOP",
        "ENOTDIR",
        "EROFS",
        "ENOSPC",
        "EDQUOT",
        "ENOENT",
      ].includes(code ?? "")
        ? code
        : "unknown";
      console.warn(
        `Could not prepare private terminal artifacts under ${root} (${reason}); this artifact root will not be used`,
      );
    }
  }
  return rootsReady;
}

export async function preparePrivateArtifactStorage(
  roots: readonly string[] = DEFAULT_ROOTS,
  commandIdentity?: CommandIdentity,
): Promise<{ ready: boolean; namespace?: string }> {
  if (commandIdentity) {
    const unavailable = (reason: string): { ready: false } => {
      console.warn(
        `Could not prepare private terminal artifacts as the command user (${reason}); private terminal saving will not be used`,
      );
      return { ready: false };
    };
    // The credential-reading client may be root while terminal commands are not.
    // Run the same no-follow preparation as that command user; never chown an
    // existing shared root or expose the parent environment to this helper.
    if (os.platform() !== "linux" || process.getuid?.() !== 0) {
      return unavailable("unsupported_identity");
    }
    const { uid, gid, home } = commandIdentity;
    if (
      !Number.isSafeInteger(uid) ||
      uid <= 0 ||
      !Number.isSafeInteger(gid) ||
      gid <= 0
    ) {
      return unavailable("invalid_identity");
    }
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          // Source-mode startup uses tsx; never inherit arbitrary parent Node
          // flags or NODE_OPTIONS into the delegated, credential-free helper.
          ...(__filename.endsWith(".ts")
            ? ["--require", require.resolve("tsx/cjs")]
            : []),
          "-e",
          "require(process.argv[1]).preparePrivateArtifactStorage(JSON.parse(process.argv[2])).then(result => process.stdout.write(JSON.stringify(result))).catch(() => process.exit(1))",
          __filename,
          JSON.stringify(roots),
        ],
        {
          uid,
          gid,
          cwd: "/",
          env: { HOME: home, NODE_ENV: "production" },
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 8192,
        },
      );
      const result: unknown = JSON.parse(stdout);
      if (
        typeof result !== "object" ||
        result === null ||
        !("ready" in result) ||
        result.ready !== true
      ) {
        return unavailable("storage_unavailable_or_invalid_response");
      }
      if ("namespace" in result && result.namespace !== `uid-${uid}`) {
        return unavailable("invalid_namespace");
      }
      return "namespace" in result
        ? { ready: true, namespace: `uid-${uid}` }
        : { ready: true };
    } catch (error) {
      // Never print the helper's captured stderr, arbitrary code or raw message.
      const details = error as { code?: unknown; killed?: boolean };
      const reason =
        error instanceof SyntaxError
          ? "invalid_response"
          : details?.killed === true
            ? "helper_terminated"
            : ["ENOENT", "EACCES", "EPERM"].includes(String(details?.code))
              ? String(details.code)
              : "helper_failed";
      return unavailable(reason);
    }
  }
  if (os.platform() === "win32" || typeof process.getuid !== "function") {
    return { ready: false };
  }
  const uid = process.getuid();
  const namespace = `uid-${uid}`;
  const fallbackRoots = roots.map((root) => `${root}-${namespace}`);
  // Keep an already-established fallback stable across CLI restarts, including
  // when the original shared roots have subsequently been repaired.
  const establishedFallback = (
    await Promise.all(
      fallbackRoots.map(async (root) => {
        const info = await lstat(root).catch(() => undefined);
        return info?.isDirectory() === true && info.uid === uid;
      }),
    )
  ).every(Boolean);
  if (
    establishedFallback &&
    (await hardenExistingTerminalArtifacts(fallbackRoots))
  ) {
    return { ready: true, namespace };
  }
  if (await hardenExistingTerminalArtifacts(roots)) return { ready: true };
  // Never chown/remove a shared root or follow its symlink. Each fallback root
  // is independently claimed with O_NOFOLLOW and an owner-only file handle.
  if (await hardenExistingTerminalArtifacts(fallbackRoots)) {
    return { ready: true, namespace };
  }
  return { ready: false };
}
