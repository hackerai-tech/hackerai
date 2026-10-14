import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_READER_PYTHON, workspaceRequest } from "../workspace-files";

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
        { encoding: "utf8" },
      ),
    );

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
    expect(read({})).toEqual({ error: "unreadable_path" });
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
