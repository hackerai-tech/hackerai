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
import { hardenExistingTerminalArtifacts } from "../private-artifact-hardening";

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
