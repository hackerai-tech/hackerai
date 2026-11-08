import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { preparePrivateArtifactStorage } from "../private-artifact-hardening";

it("loads a delegated TypeScript helper without native type stripping or inherited Node options", async () => {
  if (!process.getuid || !process.getgid || process.platform === "win32")
    return;
  const uid = process.getuid();
  const gid = process.getgid();
  const base = await mkdtemp(path.join(os.tmpdir(), "hackerai-source-helper-"));
  const childProcess = require("node:child_process");
  const realExecFile = childProcess.execFile;
  const calls: Array<{
    args: string[];
    env: NodeJS.ProcessEnv;
    uid: number;
    gid: number;
  }> = [];
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const exec = jest
    .spyOn(childProcess, "execFile")
    .mockImplementation((...raw: any[]) => {
      const [file, args, options, callback] = raw;
      calls.push({
        args,
        env: options.env,
        uid: options.uid,
        gid: options.gid,
      });
      // Exercise an actual child with Node's TS support disabled. Keep the test
      // process identity so this test does not require privileged CI; a separate
      // Linux runtime check covers the real UID split and credential isolation.
      const [major, minor] = process.versions.node.split(".").map(Number);
      const disableTypeStripping =
        major > 22 || (major === 22 && minor >= 6)
          ? ["--no-experimental-strip-types"]
          : [];
      return realExecFile(
        file,
        [...disableTypeStripping, ...args],
        { ...options, uid, gid },
        callback,
      );
    });
  Object.defineProperty(exec, promisify.custom, {
    configurable: true,
    value: (file: string, args: string[], options: any) =>
      new Promise((resolve, reject) => {
        childProcess.execFile(
          file,
          args,
          options,
          (error: Error | null, stdout: string, stderr: string) =>
            error ? reject(error) : resolve({ stdout, stderr }),
        );
      }),
  });
  const platform = jest.spyOn(os, "platform").mockReturnValue("linux");
  const getuid = jest.spyOn(process, "getuid").mockReturnValue(0);
  try {
    const result = await preparePrivateArtifactStorage(
      [path.join(base, "records"), path.join(base, "output")],
      { uid: uid || 65534, gid: gid || 65534, home: base },
    );
    expect(result.ready).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].env).toEqual({ HOME: base, NODE_ENV: "production" });
    expect(calls[0].uid).toBe(uid || 65534);
    expect(calls[0].gid).toBe(gid || 65534);
  } finally {
    getuid.mockRestore();
    platform.mockRestore();
    exec.mockRestore();
    warn.mockRestore();
    await rm(base, { recursive: true, force: true });
  }
});
