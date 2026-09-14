import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_WORKSPACE_PROBE,
  parseEmptyWorkspaceFingerprint,
} from "../empty-workspace-probe";

// The production probe requires Linux xattrs. CI runs these real-filesystem tests.
(process.platform === "linux" ? describe : describe.skip)(
  "empty workspace filesystem proof",
  () => {
    let root: string;
    const scan = () =>
      parseEmptyWorkspaceFingerprint(
        execFileSync(
          "python3",
          ["-I", "-B", "-c", EMPTY_WORKSPACE_PROBE, root],
          { encoding: "utf8" },
        ),
      );
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "hackerai-empty-test-"));
      for (const path of [
        "home/user",
        "root",
        "tmp",
        "var/tmp",
        "opt",
        "etc",
        "usr/local/bin",
      ])
        mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, "home/user/.bashrc"), "# template default\n");
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("recognizes an unchanged template, including its default dotfiles", () => {
      expect(scan()).toEqual(scan());
      expect(scan()?.entries).toBeGreaterThan(1);
    });

    it.each([
      "home/user/upload.txt",
      "home/user/.secret",
      "root/report",
      "tmp/output",
      "var/tmp/report",
      "opt/custom-tool",
      "usr/local/bin/custom-tool",
      "etc/custom-config",
    ])("detects even an empty user file at %s", (path) => {
      const baseline = scan();
      writeFileSync(join(root, path), "");
      expect(scan()?.digest).not.toBe(baseline?.digest);
    });

    it("detects modified template defaults and permissions", () => {
      const baseline = scan();
      writeFileSync(join(root, "home/user/.bashrc"), "# user customizations\n");
      expect(scan()?.digest).not.toBe(baseline?.digest);
      const changed = scan();
      chmodSync(join(root, "home/user/.bashrc"), 0o600);
      expect(scan()?.digest).not.toBe(changed?.digest);
    });

    it("records links without following them outside the tree", () => {
      const baseline = scan();
      symlinkSync("/nonexistent-private-path", join(root, "root/link"));
      expect(scan()?.digest).not.toBe(baseline?.digest);
    });

    it("fails closed for special files without leaking paths or blocking on a FIFO", () => {
      execFileSync("mkfifo", [join(root, "tmp/private-report")]);
      try {
        scan();
        throw new Error("expected failure");
      } catch (error) {
        expect((error as { stdout: string }).stdout).toBe(
          '{"version": 1, "unknown": true}\n',
        );
      }
    });

    it.each([
      "{}",
      "null",
      "[]",
      '{"version":1,"unknown":true}',
      JSON.stringify({ version: 1, digest: "a".repeat(64), entries: 0 }),
      JSON.stringify({
        version: 1,
        digest: "a".repeat(64),
        entries: 2,
        extra: true,
      }),
    ])("rejects incomplete or malformed proof %s", (value) =>
      expect(parseEmptyWorkspaceFingerprint(value)).toBeNull(),
    );
  },
);
