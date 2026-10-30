import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildShellSpawn, findGitBash } from "../utils";

const integrationBash =
  process.platform === "win32" ? findGitBash() : "/bin/bash";
// Git Bash is optional locally, but Windows CI must exercise this regression.
const testWithBash = integrationBash || process.env.CI ? it : it.skip;

describe("Windows shell discovery", () => {
  const originalSystemRoot = process.env.SystemRoot;

  afterEach(() => {
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
    jest.dontMock("fs");
    jest.dontMock("child_process");
  });

  testWithBash(
    "initializes Git Bash utilities for non-interactive file writes with a Windows-only PATH",
    () => {
      // Execute the Windows invocation on real Bash. Windows CI uses Git Bash;
      // POSIX hosts exercise the same generated script without a Windows VM.
      const bash = integrationBash!;
      expect(bash).toBeTruthy();
      const content = "literal 'quotes' $HOME `not-a-command` \u03bb\n";
      const command = `printf '%s' '${Buffer.from(content).toString("base64")}' | base64 -d`;
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key.toLowerCase() !== "path",
        ),
      );
      env.PATH =
        process.platform === "win32"
          ? `${process.env.SystemRoot}\\System32`
          : "/nonexistent-hackerai-test-bin";
      const invocation = buildShellSpawn(
        "C:\\Git\\bin\\bash.exe",
        "-c",
        command,
      );
      expect(
        execFileSync(bash, invocation.args, {
          ...invocation.options,
          env,
          encoding: "utf8",
          timeout: 5000,
        }),
      ).toBe(content);
    },
  );

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
      const gitMarker = `git-${root}`;
      const bashMarker = `bash-${root}`;
      const oldCwd = process.cwd();
      try {
        mkdirSync(project, { recursive: true });
        mkdirSync(gitCmd, { recursive: true });
        mkdirSync(gitBin, { recursive: true });
        writeFileSync(
          join(project, "where.bat"),
          `@echo off\r\necho ran > "${marker}"\r\n`,
        );
        writeFileSync(join(gitCmd, "git.exe"), gitMarker);
        writeFileSync(join(gitBin, "bash.exe"), bashMarker);
        process.chdir(project);
        // Windows runners may carry both PATH and Path. Give where.exe one
        // unambiguous search path without changing the Jest process environment.
        const childEnv = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key.toLowerCase() !== "path",
          ),
        );
        childEnv.Path = gitCmd;

        const systemWhere = join(
          process.env.SystemRoot!,
          "System32",
          "where.exe",
        );
        const discoveredGit = execFileSync(systemWhere, ["$PATH:git.exe"], {
          encoding: "utf8",
          windowsHide: true,
          env: childEnv,
        }).trim();
        expect(readFileSync(discoveredGit, "utf8")).toBe(gitMarker);

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
          jest.doMock("child_process", () => ({
            execFileSync: (file: string, args: string[]) =>
              execFileSync(file, args, { encoding: "utf8", env: childEnv }),
          }));
          utils = require("../utils");
        });

        expect(readFileSync(utils!.findGitBash()!, "utf8")).toBe(bashMarker);
        expect(existsSync(marker)).toBe(false);
      } finally {
        process.chdir(oldCwd);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
