import { randomUUID } from "node:crypto";
import type { Sandbox } from "@miosa/sdk";
import { logger } from "@/lib/logger";
import { miosaRuntimeCommand, type MiosaRuntime } from "./miosa-runtime";

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

// Files must address the same native guest or legacy Kali container as commands,
// including /tmp and relative paths. Staging preserves binary transfer semantics.
const FILE_OPERATION = `
import json, os, shutil, stat
op = os.environ['HACKERAI_FILE_OP']
path = os.environ['HACKERAI_FILE_PATH']
stage = os.environ.get('HACKERAI_FILE_STAGE')
if op == 'write':
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(stage, 'rb') as src, open(path, 'wb') as dst:
        shutil.copyfileobj(src, dst)
elif op == 'read':
    with open(path, 'rb') as src, open(stage, 'wb') as dst:
        shutil.copyfileobj(src, dst)
elif op == 'list':
    print(json.dumps([{'name': n, 'path': os.path.join(path, n)} for n in os.listdir(path)]))
elif op == 'stat':
    info = os.stat(path)
    print(json.dumps({'size': info.st_size, 'isDir': stat.S_ISDIR(info.st_mode),
        'modifiedAt': info.st_mtime * 1000,
        'symlinkTarget': os.readlink(path) if os.path.islink(path) else None}))
elif op == 'exists':
    print(json.dumps(os.path.exists(path)))
elif op == 'remove':
    if os.path.islink(path) or os.path.isfile(path): os.unlink(path)
    elif os.path.isdir(path): shutil.rmtree(path)
`;

export function createMiosaFiles(
  sandbox: Sandbox,
  runtime: MiosaRuntime = "docker",
) {
  const operate = async (op: string, path: string, stage?: string) => {
    const env = {
      HACKERAI_FILE_OP: op,
      HACKERAI_FILE_PATH: path,
      ...(stage && { HACKERAI_FILE_STAGE: stage }),
    };
    const flags = Object.entries(env)
      .map(([key, value]) => `--env ${quote(`${key}=${value}`)}`)
      .join(" ");
    const result = await sandbox.exec.run(
      runtime === "native"
        ? miosaRuntimeCommand("native", `python3 -c ${quote(FILE_OPERATION)}`, {
            envs: env,
          })
        : `docker exec --workdir /home/user ${flags} hackerai-agent python3 -c ${quote(FILE_OPERATION)}`,
      { timeoutSec: 60 },
    );
    if (result.exitCode !== 0)
      throw new Error(result.stderr || `MIOSA file ${op} failed`);
    return result.stdout;
  };
  const transfer = async <T>(operation: (stage: string) => Promise<T>) => {
    const stage = `/home/user/.hackerai-transfer-${randomUUID()}`;
    const cleanup = async () => {
      const result = await sandbox.exec.run(`rm -f -- ${quote(stage)}`, {
        timeoutSec: 10,
      });
      if (result.exitCode !== 0)
        throw new Error("MIOSA file transfer cleanup failed");
    };
    let result: T;
    try {
      result = await operation(stage);
    } catch (error) {
      await cleanup().catch(() => undefined);
      throw error;
    }
    // The transfer has completed. A leftover staging file must not discard a
    // read result or prompt the caller to repeat a successful write.
    await cleanup().catch(() => {
      logger.warn("MIOSA file transfer staging cleanup failed", {
        event: "miosa_file_cleanup_failed",
        service: "miosa-files",
        environment:
          process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        sandbox_provider: "miosa",
        sandbox_id: sandbox.id,
      });
    });
    return result;
  };
  const read = (path: string) =>
    transfer(async (stage) => {
      await operate("read", path, stage);
      return sandbox.files.readText(stage);
    });
  const statFile = async (
    path: string,
  ): Promise<{
    size: number;
    isDir: boolean;
    modifiedAt: number;
    symlinkTarget: string | null;
  }> => JSON.parse(await operate("stat", path));
  return {
    write: (
      path: string,
      content: string | Buffer | ArrayBuffer,
    ): Promise<void> =>
      transfer(async (stage) => {
        await sandbox.files.write(
          stage,
          content instanceof ArrayBuffer ? new Uint8Array(content) : content,
        );
        await operate("write", path, stage);
      }),
    read,
    readText: read,
    list: async (
      path: string,
    ): Promise<Array<{ name: string; path: string }>> =>
      JSON.parse(await operate("list", path)),
    stat: statFile,
    exists: async (path: string): Promise<boolean> =>
      JSON.parse(await operate("exists", path)),
    getInfo: async (path: string) => {
      const info = await statFile(path);
      return {
        type: info.isDir ? "dir" : "file",
        size: info.size,
        modifiedTime: new Date(info.modifiedAt),
        symlinkTarget: info.symlinkTarget ?? undefined,
      };
    },
    remove: async (path: string): Promise<void> => {
      await operate("remove", path);
    },
  };
}
