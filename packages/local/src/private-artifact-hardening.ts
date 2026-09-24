import { constants } from "node:fs";
import { mkdir, open, readdir } from "node:fs/promises";
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

const claimOwnedRoot = async (root: string, uid: number): Promise<boolean> => {
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return hardenOwnedDirectory(root, uid);
};

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
          `Could not claim private terminal artifact root ${root}; private persistence will remain disabled`,
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
      console.warn(
        `Could not harden legacy terminal artifacts under ${root}; private persistence will remain disabled`,
      );
    }
  }
  return rootsReady;
}
