import { constants } from "node:fs";
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
): Promise<{ ready: boolean; namespace?: string }> {
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
