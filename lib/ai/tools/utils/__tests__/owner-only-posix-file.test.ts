import {
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  readOwnerOnlyPosixFile,
  writeOwnerOnlyPosixFile,
} from "../owner-only-posix-file";

const runShell = (
  command: string,
  stdin?: string | Buffer,
): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
  new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", `umask 022\n${command}`], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) =>
      resolve({
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        exitCode: exitCode ?? 1,
      }),
    );
    child.stdin.end(stdin);
  });

const mode = async (target: string): Promise<number> =>
  (await stat(target)).mode & 0o777;

describe("owner-only POSIX terminal artifacts", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  const fixture = () => {
    const root = path.posix.join(
      "/tmp",
      `hackerai-private-artifacts-${crypto.randomUUID()}`,
    );
    const directory = path.posix.join(root, "scope");
    const filePath = path.posix.join(directory, "record.json");
    roots.push(root);
    const commands = {
      run: jest.fn(
        async (command: string, opts?: { stdin?: string | Buffer }) =>
          runShell(command, opts?.stdin),
      ),
    };
    const sandbox = {
      sandboxKind: "centrifugo",
      supportsCommandStdin: () => true,
      supportsNativeFileRelay: () => false,
      isWindows: () => false,
      commands,
    } as any;
    return { root, directory, filePath, sandbox, commands };
  };

  it("writes content through stdin with owner-only permissions", async () => {
    const { root, directory, filePath, sandbox, commands } = fixture();
    const content = "secret $(touch /tmp/not-executed) ' \" ;\nsecond line";
    await mkdir(root, { mode: 0o700 });

    await writeOwnerOnlyPosixFile(sandbox, root, directory, filePath, content);

    expect(await readFile(filePath, "utf8")).toBe(content);
    expect(await mode(root)).toBe(0o700);
    expect(await mode(directory)).toBe(0o700);
    expect(await mode(filePath)).toBe(0o600);
    expect(
      commands.run.mock.calls.map(([command]) => command).join("\n"),
    ).not.toContain(content);
    expect(commands.run.mock.calls.some(([, opts]) => opts?.stdin)).toBe(true);
  });

  it("tightens legacy permissions when reading an existing artifact", async () => {
    const { root, directory, filePath, sandbox } = fixture();
    await mkdir(directory, { recursive: true, mode: 0o755 });
    await writeFile(filePath, "legacy evidence", { mode: 0o644 });
    await Promise.all([
      import("node:fs/promises").then(({ chmod }) => chmod(root, 0o755)),
      import("node:fs/promises").then(({ chmod }) => chmod(directory, 0o755)),
      import("node:fs/promises").then(({ chmod }) => chmod(filePath, 0o644)),
    ]);

    await expect(
      readOwnerOnlyPosixFile(sandbox, root, directory, filePath, 100),
    ).resolves.toBe("legacy evidence");
    expect(await mode(root)).toBe(0o700);
    expect(await mode(directory)).toBe(0o700);
    expect(await mode(filePath)).toBe(0o600);
  });

  it("rejects symlink targets without changing the linked file", async () => {
    const { root, directory, filePath, sandbox } = fixture();
    const outside = `${root}-outside`;
    roots.push(outside);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(outside, "do not overwrite", { mode: 0o600 });
    await symlink(outside, filePath);

    await expect(
      writeOwnerOnlyPosixFile(
        sandbox,
        root,
        directory,
        filePath,
        "private evidence",
      ),
    ).rejects.toThrow("operation failed");
    expect(await readFile(outside, "utf8")).toBe("do not overwrite");
  });
});
