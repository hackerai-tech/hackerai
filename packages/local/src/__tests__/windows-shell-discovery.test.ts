import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("Windows shell discovery", () => {
  const originalSystemRoot = process.env.SystemRoot;

  afterEach(() => {
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
    jest.dontMock("fs");
    jest.dontMock("child_process");
  });

  it("discovers portable Git through the system where.exe without searching the current directory", () => {
    process.env.SystemRoot = "C:\\Windows";
    const existsSync = jest.fn(
      (path: string) => path === "C:\\Portable\\Git\\bin\\bash.exe",
    );
    const execFileSync = jest.fn(() => "C:\\Portable\\Git\\cmd\\git.exe\r\n");
    let utils: typeof import("../utils") | undefined;
    jest.isolateModules(() => {
      jest.doMock("fs", () => ({ existsSync }));
      jest.doMock("child_process", () => ({ execFileSync }));
      utils = require("../utils");
    });

    expect(utils!.findGitBash()).toBe("C:\\Portable\\Git\\bin\\bash.exe");
    expect(execFileSync).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\where.exe",
      ["$PATH:git.exe"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("falls back to the system cmd.exe when Git is unavailable", () => {
    process.env.SystemRoot = "D:\\Windows";
    const existsSync = jest.fn(() => false);
    const execFileSync = jest.fn(() => {
      throw new Error("Git not found");
    });
    let utils: typeof import("../utils") | undefined;
    jest.isolateModules(() => {
      jest.doMock("fs", () => ({ existsSync }));
      jest.doMock("child_process", () => ({ execFileSync }));
      utils = require("../utils");
    });

    expect(utils!.getDefaultShell("win32")).toEqual({
      shell: "D:\\Windows\\System32\\cmd.exe",
      shellFlag: "/C",
    });
    expect(utils!.windowsSystemExecutable("taskkill.exe")).toBe(
      "D:\\Windows\\System32\\taskkill.exe",
    );
  });

  const windowsIt = process.platform === "win32" ? it : it.skip;
  windowsIt(
    "does not execute a project-local where.bat during portable Git lookup",
    () => {
      const root = mkdtempSync(join(tmpdir(), "hackerai-shell-"));
      const project = join(root, "project");
      const gitCmd = join(root, "portable", "Git", "cmd");
      const gitBin = join(root, "portable", "Git", "bin");
      const marker = join(root, "where-ran.txt");
      const oldCwd = process.cwd();
      const oldPath = process.env.PATH;
      try {
        mkdirSync(project, { recursive: true });
        mkdirSync(gitCmd, { recursive: true });
        mkdirSync(gitBin, { recursive: true });
        writeFileSync(
          join(project, "where.bat"),
          `@echo off\r\necho ran > "${marker}"\r\n`,
        );
        writeFileSync(join(gitCmd, "git.exe"), "");
        writeFileSync(join(gitBin, "bash.exe"), "");
        process.chdir(project);
        process.env.PATH = gitCmd;

        const realFs = jest.requireActual<typeof import("fs")>("fs");
        let utils: typeof import("../utils") | undefined;
        jest.isolateModules(() => {
          jest.doMock("fs", () => ({
            ...realFs,
            existsSync: (path: string) =>
              path.startsWith("C:\\Program Files")
                ? false
                : realFs.existsSync(path),
          }));
          utils = require("../utils");
        });

        expect(utils!.findGitBash()).toBe(join(gitBin, "bash.exe"));
        expect(existsSync(marker)).toBe(false);
      } finally {
        process.chdir(oldCwd);
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
