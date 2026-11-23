import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  unreadableListDiagnostics,
  WORKSPACE_READER_PYTHON,
  workspaceReaderCommand,
  workspaceRequest,
} from "../workspace-files";

describe("workspace reader filesystem boundary", () => {
  let fixture: string;
  let root: string;
  beforeEach(() => {
    fixture = realpathSync(mkdtempSync(join(tmpdir(), "workspace-reader-")));
    root = join(fixture, "workspace");
    mkdirSync(root);
  });
  afterEach(() => rmSync(fixture, { recursive: true, force: true }));
  const read = (input: Record<string, unknown>) =>
    JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          WORKSPACE_READER_PYTHON,
          Buffer.from(
            JSON.stringify({
              action: "list",
              path: "",
              search: "",
              offset: 0,
              limit: 1024,
              ...input,
            }),
          ).toString("base64"),
          root,
        ],
        { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
      ),
    );

  it("lists the working directory independently of Python environment settings", () => {
    writeFileSync(join(root, "report.txt"), "fixture");
    const request = workspaceRequest.parse({ chatId: "chat", action: "list" });
    const output = execFileSync(
      "sh",
      ["-c", workspaceReaderCommand(request, null)],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PYTHONHOME: join(fixture, "missing-python-home"),
        },
      },
    );
    expect(JSON.parse(output)).toMatchObject({
      root,
      entries: [{ name: "report.txt", kind: "file", size: 7 }],
    });
  });

  it("lists actual nested files with metadata and reads exact binary bytes", () => {
    mkdirSync(join(root, "reports"));
    const bytes = Buffer.from([0, 255, 128, 34, 10]);
    writeFileSync(join(root, "reports", "quote'$(touch nope).bin"), bytes);
    expect(read({}).entries).toEqual([
      expect.objectContaining({ name: "reports", kind: "directory" }),
    ]);
    expect(read({ path: "reports" }).entries[0]).toMatchObject({
      kind: "file",
      size: 5,
    });
    expect(
      Buffer.from(
        read({ action: "download", path: "reports/quote'$(touch nope).bin" })
          .data,
        "base64",
      ),
    ).toEqual(bytes);
  });

  it("rejects traversal, absolute paths, symlink files, symlink directories and a symlink root", () => {
    writeFileSync(join(fixture, "outside"), "PRIVATE");
    symlinkSync(join(fixture, "outside"), join(root, "link"));
    symlinkSync(fixture, join(root, "outside-dir"));
    expect(read({ action: "download", path: "link" })).toEqual({
      error: "unreadable_path",
    });
    expect(read({ action: "download", path: "outside-dir/outside" })).toEqual({
      error: "unreadable_path",
    });
    expect(read({ action: "download", path: "../outside" })).toEqual({
      error: "invalid_path",
    });
    expect(read({ action: "download", path: "/etc/passwd" })).toEqual({
      error: "invalid_path",
    });
    const linked = join(fixture, "linked");
    symlinkSync(root, linked);
    root = linked;
    expect(read({})).toEqual({
      error: "unreadable_path",
      phase: "root",
      category: "not_directory_or_symlink",
    });
  });

  it("labels the list phase that hit a file where a directory was expected", () => {
    writeFileSync(join(root, "report.txt"), "fixture");
    const notDirectory = {
      error: "unreadable_path",
      category: "not_directory_or_symlink",
    };
    expect(read({ path: "report.txt" })).toEqual({
      ...notDirectory,
      phase: "directory",
    });
    // Non-list actions keep the original reader body.
    expect(read({ action: "download", path: "report.txt/x" })).toEqual({
      error: "unreadable_path",
    });
    root = join(root, "report.txt");
    expect(read({})).toEqual({ ...notDirectory, phase: "root" });
  });

  // Root bypasses directory search permission, so this cannot fail there.
  (process.getuid?.() === 0 ? it.skip : it)(
    "labels a per-entry stat permission failure separately from opening the folder",
    () => {
      mkdirSync(join(root, "locked"));
      writeFileSync(join(root, "locked", "report.txt"), "fixture");
      chmodSync(join(root, "locked"), 0o444);
      try {
        expect(read({ path: "locked" })).toEqual({
          error: "unreadable_path",
          phase: "entry_stat",
          category: "permission",
        });
      } finally {
        chmodSync(join(root, "locked"), 0o755);
      }
    },
  );

  it.each([
    [
      "allow-listed reader labels",
      "list",
      {
        error: "unreadable_path",
        phase: "enumerate",
        category: "io",
      },
      { reader: "local", reader_phase: "enumerate", os_error_category: "io" },
    ],
    [
      "an older reader without labels",
      "list",
      { error: "unreadable_path" },
      { reader: "local" },
    ],
    [
      "unexpected label values and fields",
      "list",
      {
        error: "unreadable_path",
        phase: "/home/user/private",
        category: 13,
        errno: 13,
        message: "Permission denied: '/home/user/private'",
      },
      { reader: "local" },
    ],
    [
      "another error code",
      "list",
      { error: "not_found", phase: "root", category: "permission" },
      undefined,
    ],
    [
      "a status request listed by the reader",
      "status",
      { error: "unreadable_path", phase: "root", category: "permission" },
      undefined,
    ],
    ["non-object output", "list", "unreadable_path", undefined],
  ] as const)(
    "keeps only closed list diagnostics for %s",
    (_case, action, output, expected) => {
      expect(unreadableListDiagnostics("local", action, output)).toEqual(
        expected,
      );
    },
  );

  it("downloads larger files in revision-pinned chunks and rejects changes between chunks", () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 42);
    writeFileSync(join(root, "large.bin"), bytes);
    const first = read({
      action: "download",
      path: "large.bin",
      limit: bytes.length,
    });
    expect(first.nextByteOffset).toBe(1024 * 1024);
    const second = read({
      action: "download",
      path: "large.bin",
      limit: bytes.length,
      byteOffset: first.nextByteOffset,
      revision: first.revision,
    });
    expect(Buffer.from(second.data, "base64")).toEqual(
      bytes.subarray(1024 * 1024, 2 * 1024 * 1024),
    );
    writeFileSync(join(root, "large.bin"), Buffer.alloc(bytes.length, 24));
    expect(
      read({
        action: "download",
        path: "large.bin",
        limit: bytes.length,
        byteOffset: first.nextByteOffset,
        revision: first.revision,
      }),
    ).toEqual({ error: "file_changed" });
  });

  it("paginates and searches a folder without recursively inspecting children", () => {
    for (let i = 0; i < 103; i++)
      writeFileSync(
        join(root, `report-${String(i).padStart(3, "0")}.txt`),
        "x",
      );
    const first = read({});
    const second = read({ offset: first.nextOffset });
    expect(first.entries).toHaveLength(100);
    expect(second.entries).toHaveLength(3);
    expect(second.nextOffset).toBeNull();
    expect(
      read({ search: "REPORT-102" }).entries.map(
        (entry: { name: string }) => entry.name,
      ),
    ).toEqual(["report-102.txt"]);
  });

  it("rejects oversized files and special files instead of hanging or returning partial downloads", () => {
    writeFileSync(join(root, "large"), Buffer.alloc(1025));
    expect(read({ action: "download", path: "large" })).toEqual({
      error: "file_too_large",
    });
    execFileSync("mkfifo", [join(root, "pipe")]);
    expect(read({ action: "download", path: "pipe" })).toEqual({
      error: "not_file",
    });
  });

  it.each([
    "../secret",
    "a/../b",
    "/etc/passwd",
    "a//b",
    "a/./b",
    "a\\b",
    "a\0b",
  ])("rejects unsafe request path %s before provider I/O", (path) => {
    expect(
      workspaceRequest.safeParse({ chatId: "chat", action: "list", path })
        .success,
    ).toBe(false);
  });
});
