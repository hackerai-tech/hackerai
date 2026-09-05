import { randomUUID } from "node:crypto";
import type { Sandbox } from "@miosa/sdk";

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

// Commands and files must address the Kali container, including /tmp and
// relative paths. The shared home directory is only a binary transfer channel.
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

export function createMiosaFiles(sandbox: Sandbox) {
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
      `docker exec --workdir /home/user ${flags} hackerai-agent python3 -c ${quote(FILE_OPERATION)}`,
      { timeoutSec: 60 },
    );
    if (result.exitCode !== 0)
      throw new Error(result.stderr || `MIOSA file ${op} failed`);
    return result.stdout;
  };
  const transfer = async <T>(operation: (stage: string) => Promise<T>) => {
    const stage = `/home/user/.hackerai-transfer-${randomUUID()}`;
    let failed = false;
    try {
      return await operation(stage);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        const cleanup = await sandbox.exec.run(`rm -f -- ${quote(stage)}`, {
          timeoutSec: 10,
        });
        if (cleanup.exitCode !== 0)
          throw new Error("MIOSA file transfer cleanup failed");
      } catch (error) {
        if (!failed) throw error;
      }
    }
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
