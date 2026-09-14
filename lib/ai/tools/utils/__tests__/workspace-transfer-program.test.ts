import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_TRANSFER_PROGRAM } from "../workspace-transfer-program";

// The deployed probe relies on Linux xattrs. Run these exact fixtures in CI.
(process.platform === "linux" ? describe : describe.skip)(
  "real filesystem migration",
  () => {
    let directory: string,
      source: string,
      target: string,
      stage: string,
      destinationStage: string;
    const run = (operation: string, selectedStage = stage, root = source) => {
      const program = WORKSPACE_TRANSFER_PROGRAM.replace(
        "except Exception:",
        "except Exception as error:\n    print(type(error).__name__, str(error), file=sys.stderr)",
      );
      const result = spawnSync(
        "python3",
        ["-I", "-B", "-c", program, operation, selectedStage, root],
        { encoding: "utf8" },
      );
      if (result.status !== 0)
        throw new Error(`${operation}: ${result.stderr}`);
      return JSON.parse(result.stdout);
    };
    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), "hackerai-transfer-test-"));
      source = join(directory, "source");
      target = join(directory, "target");
      for (const root of [source, target]) {
        mkdirSync(join(root, "home/user"), { recursive: true });
        mkdirSync(join(root, "etc"), { recursive: true });
      }
      stage = join(source, ".hackerai-migration-test");
      destinationStage = join(target, ".hackerai-migration-test");
      writeFileSync(
        join(source, "home/user/.secret"),
        Buffer.from([0, 255, 1, 2, 3]),
      );
      writeFileSync(join(source, "home/user/empty"), "");
      writeFileSync(join(source, "etc/custom.conf"), "preserve in archive");
      chmodSync(join(source, "home/user/.secret"), 0o600);
    });
    afterEach(() => rmSync(directory, { recursive: true, force: true }));
    const transfer = () => {
      const capture = run("export");
      mkdirSync(destinationStage);
      copyFileSync(
        join(stage, "source.tar.gz"),
        join(destinationStage, "source.tar.gz"),
      );
      const restored = run("restore", destinationStage, target);
      expect(restored.archiveDigest).toBe(capture.archiveDigest);
      expect(restored.homeDigest).toBe(capture.homeDigest);
      run("install", destinationStage, target);
      expect(run("verify-home", destinationStage, target).homeDigest).toBe(
        capture.homeDigest,
      );
      return capture;
    };
    it("preserves binary, hidden and empty files, modes and source contents", () => {
      const capture = transfer();
      expect(readFileSync(join(target, "home/user/.secret"))).toEqual(
        Buffer.from([0, 255, 1, 2, 3]),
      );
      expect(statSync(join(target, "home/user/.secret")).mode & 0o777).toBe(
        0o600,
      );
      expect(statSync(join(target, "home/user/empty")).size).toBe(0);
      expect(run("verify-source").digest).toBe(capture.digest);
      const names = execFileSync(
        "python3",
        [
          "-c",
          "import tarfile,sys,json; print(json.dumps(tarfile.open(sys.argv[1]).getnames()))",
          join(destinationStage, "source.tar.gz"),
        ],
        { encoding: "utf8" },
      );
      expect(names).toContain("etc/custom.conf");
    });
    it("preserves hardlink topology and internal symlinks", () => {
      linkSync(
        join(source, "home/user/.secret"),
        join(source, "home/user/hard"),
      );
      symlinkSync(".secret", join(source, "home/user/link"));
      symlinkSync(".", join(source, "home/user/self"));
      transfer();
      expect(statSync(join(target, "home/user/.secret")).ino).toBe(
        statSync(join(target, "home/user/hard")).ino,
      );
      expect(readFileSync(join(target, "home/user/link"))).toEqual(
        readFileSync(join(source, "home/user/.secret")),
      );
      expect(readFileSync(join(target, "home/user/self/.secret"))).toEqual(
        readFileSync(join(source, "home/user/.secret")),
      );
    });
    it("detects changed system files and user files after export", () => {
      const capture = run("export");
      writeFileSync(join(source, "etc/custom.conf"), "edited later");
      expect(run("verify-source").digest).not.toBe(capture.digest);
      writeFileSync(join(source, "home/user/new.txt"), "new");
      expect(run("verify-home").homeDigest).not.toBe(capture.homeDigest);
    });
    it("defers workspaces whose links depend on un-restored files", () => {
      symlinkSync("/etc/custom.conf", join(source, "home/user/external"));
      expect(() => run("export")).toThrow();
      expect(readFileSync(join(source, "etc/custom.conf"), "utf8")).toBe(
        "preserve in archive",
      );
    });
    it("refuses archive path traversal before it can escape staging", () => {
      mkdirSync(destinationStage);
      execFileSync("python3", [
        "-c",
        "import tarfile,sys; t=tarfile.open(sys.argv[1],'w:gz'); i=tarfile.TarInfo('home/user/../../../escaped'); t.addfile(i); t.close()",
        join(destinationStage, "source.tar.gz"),
      ]);
      expect(() => run("restore", destinationStage, target)).toThrow();
    });
    it("checks destination home mounts without requiring E2B system mounts", () => {
      const checkMount = (mount: string) => {
        // Inject mount metadata while retaining a real isolated filesystem.
        const harness = `import builtins,io,os,sys
original_open=builtins.open
original_abspath=os.path.abspath
def fixture_open(path,*args,**kwargs):
    if path == '/proc/self/mountinfo': return io.StringIO(${JSON.stringify("1 0 0:1 / " + mount + " rw - ext4 none rw\n")})
    return original_open(path,*args,**kwargs)
builtins.open=fixture_open
os.path.abspath=lambda path: '/' if path == sys.argv[3] else original_abspath(path)
`;
        return spawnSync(
          "python3",
          [
            "-I",
            "-B",
            "-c",
            harness + WORKSPACE_TRANSFER_PROGRAM,
            "verify-home",
            stage,
            source,
          ],
          { encoding: "utf8" },
        );
      };
      expect(checkMount("/etc/hosts").status).toBe(0);
      expect(checkMount("/home/user").status).toBe(1);
      expect(checkMount("/home/user/mounted").status).toBe(1);
    });
  },
);
