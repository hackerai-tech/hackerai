import {
  chmod,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  hardenExistingTerminalArtifacts,
  preparePrivateArtifactStorage,
} from "../private-artifact-hardening";

const mode = async (target: string): Promise<number> =>
  (await stat(target)).mode & 0o777;

describe("legacy private terminal artifact hardening", () => {
  it("atomically creates a missing owner-only root", async () => {
    const base = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(path.join(os.tmpdir(), "hackerai-artifact-root-")),
    );
    const root = path.join(base, "terminal_full_output");
    try {
      await expect(hardenExistingTerminalArtifacts([root])).resolves.toBe(true);
      expect(await mode(root)).toBe(0o700);
    } finally {
      await rm(base, { recursive: true });
    }
  });

  it("tightens owned paths without following symlinks", async () => {
    const base = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(path.join(os.tmpdir(), "hackerai-artifact-hardening-")),
    );
    const root = path.join(base, "terminal_execution_records");
    const scope = path.join(root, "scope");
    const record = path.join(scope, "record.json");
    const outside = path.join(base, "outside.txt");
    const linked = path.join(scope, "linked.json");
    try {
      await mkdir(scope, { recursive: true, mode: 0o755 });
      await writeFile(record, "record", { mode: 0o644 });
      await writeFile(outside, "outside", { mode: 0o644 });
      await symlink(outside, linked);
      await Promise.all([
        chmod(root, 0o755),
        chmod(scope, 0o755),
        chmod(record, 0o644),
      ]);

      await expect(hardenExistingTerminalArtifacts([root])).resolves.toBe(true);

      expect(await mode(root)).toBe(0o700);
      expect(await mode(scope)).toBe(0o700);
      expect(await mode(record)).toBe(0o600);
      expect(await mode(outside)).toBe(0o644);
      expect(await readFile(linked, "utf8")).toBe("outside");
    } finally {
      await rm(base, { recursive: true });
    }
  });

  it("atomically rejects a symlinked root without changing its target", async () => {
    const base = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(path.join(os.tmpdir(), "hackerai-artifact-symlink-")),
    );
    const root = path.join(base, "terminal_full_output");
    const target = path.join(base, "target");
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mkdir(target, { mode: 0o755 });
      await symlink(target, root);

      await expect(hardenExistingTerminalArtifacts([root])).resolves.toBe(
        false,
      );
      expect(await mode(target)).toBe(0o755);
    } finally {
      warnSpy.mockRestore();
      await rm(base, { recursive: true });
    }
  });
});

// A blocked shared root must not disable another user's independently owned storage.
describe("private artifact fallback", () => {
  it("uses owned per-user roots without touching a blocked legacy target", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const base = await mkdtemp(path.join(os.tmpdir(), "hackerai-fallback-"));
    const roots = [path.join(base, "records"), path.join(base, "output")];
    const outside = path.join(base, "outside");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mkdir(outside, { mode: 0o755 });
      await symlink(outside, roots[0]);
      const prepared = await preparePrivateArtifactStorage(roots);
      expect(prepared).toEqual({
        ready: true,
        namespace: `uid-${process.getuid!()}`,
      });
      for (const root of roots)
        expect(await mode(`${root}-${prepared.namespace}`)).toBe(0o700);
      expect(await mode(outside)).toBe(0o755);
      expect(await preparePrivateArtifactStorage(roots)).toEqual(prepared);
      await rm(roots[0]);
      await mkdir(roots[0], { mode: 0o700 });
      // Repairing the legacy root must not strand this client's saved records.
      expect(await preparePrivateArtifactStorage(roots)).toEqual(prepared);
    } finally {
      warn.mockRestore();
      await rm(base, { recursive: true });
    }
  });

  it("keeps capability disabled if the fallback is unsafe too", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const base = await mkdtemp(
      path.join(os.tmpdir(), "hackerai-fallback-denied-"),
    );
    const root = path.join(base, "records");
    const outside = path.join(base, "outside");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mkdir(outside, { mode: 0o755 });
      await symlink(outside, root);
      await symlink(outside, `${root}-uid-${process.getuid!()}`);
      expect(await preparePrivateArtifactStorage([root])).toEqual({
        ready: false,
      });
      expect(await mode(outside)).toBe(0o755);
    } finally {
      warn.mockRestore();
      await rm(base, { recursive: true });
    }
  });
});
