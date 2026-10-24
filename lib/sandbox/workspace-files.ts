import { z } from "zod";

export const WORKSPACE_FILES_FLAG = "sandbox-workspace-files";
export const WORKSPACE_DOWNLOAD_LIMIT = 50 * 1024 * 1024;
export const WORKSPACE_PREVIEW_LIMIT = 256 * 1024;

// Paths are relative to the server-selected root. Never normalize away traversal.
export const workspacePath = z
  .string()
  .max(2048)
  .refine(
    (value) =>
      value === "" ||
      (!/[\\\x00-\x1f\x7f]/.test(value) &&
        !value.startsWith("/") &&
        value
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== "..")),
  );

export const workspaceRequest = z
  .object({
    chatId: z.string().min(1).max(128),
    action: z.enum(["status", "list", "preview", "download", "resume"]),
    sandboxId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(128)
      .optional(),
    environment: z.string().min(1).max(160).optional(),
    byteOffset: z
      .number()
      .int()
      .min(0)
      .max(WORKSPACE_DOWNLOAD_LIMIT)
      .default(0),
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    path: workspacePath.default(""),
    search: z.string().max(100).default(""),
    offset: z.number().int().min(0).max(5000).default(0),
  })
  .strict();
export type WorkspaceRequest = z.infer<typeof workspaceRequest>;
export type WorkspaceEntry = {
  name: string;
  kind: "directory" | "file" | "symlink" | "other";
  size: number;
  modified: number;
};
export type WorkspaceListing = {
  entries: WorkspaceEntry[];
  total: number;
  nextOffset: number | null;
};
export type WorkspaceStatus = {
  state: "running" | "paused" | "missing" | "unsupported" | "disconnected";
  sandboxId?: string;
  root?: string;
  environmentLabel?: string;
};

export class WorkspaceFileError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(code);
  }
}

/** Run inside the cloud sandbox. Descriptor-relative opens reject symlinks at
 * every component, including the root, without a check-then-read path race.
 * No shell commands, file content, or filenames are interpolated as Python.
 */
export const WORKSPACE_READER_PYTHON = String.raw`
import os, sys, json, base64, stat, hashlib
request = json.loads(base64.b64decode(sys.argv[1]))
root = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
fds = []
def open_dir(name, parent=None):
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    fds.append(fd)
    return fd
try:
    path = request['path']
    parts = path.split('/') if path else []
    if any(p in ('', '.', '..') or '\\' in p or any(ord(c) < 32 or ord(c) == 127 for c in p) for p in parts):
        raise ValueError('invalid_path')
    directory = open_dir('/')
    for part in root.strip('/').split('/'):
        directory = open_dir(part, directory)
    listing = request['action'] == 'list'
    for part in (parts if listing else parts[:-1]):
        directory = open_dir(part, directory)
    if listing:
        entries = []
        count = 0
        with os.scandir(directory) as iterator:
            for entry in iterator:
                count += 1
                if count > 5000:
                    raise ValueError('directory_too_large')
                if request['search'].casefold() not in entry.name.casefold():
                    continue
                if any(ord(c) < 32 or ord(c) == 127 for c in entry.name) or '\\' in entry.name:
                    continue
                try:
                    info = entry.stat(follow_symlinks=False)
                except FileNotFoundError:
                    continue
                kind = 'symlink' if stat.S_ISLNK(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'other'
                entries.append(dict(name=entry.name, kind=kind, size=info.st_size, modified=int(info.st_mtime * 1000)))
        entries.sort(key=lambda e: (e['kind'] != 'directory', e['name']))
        offset = request['offset']
        print(json.dumps(dict(root=root, entries=entries[offset:offset+100], total=len(entries), nextOffset=offset+100 if offset+100 < len(entries) else None)))
    else:
        if not parts:
            raise ValueError('not_file')
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        fds.append(fd)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('not_file')
        limit = request['limit']
        if info.st_size > limit:
            raise ValueError('file_too_large')
        revision = hashlib.sha256(json.dumps([info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]).encode()).hexdigest()
        if request.get('revision') and revision != request['revision']:
            raise ValueError('file_changed')
        offset = request.get('byteOffset', 0)
        if offset and not request.get('revision'):
            raise ValueError('invalid_request')
        if offset > info.st_size:
            raise ValueError('file_changed')
        os.lseek(fd, offset, os.SEEK_SET)
        chunks = []
        remaining = min(limit + 1, 1024 * 1024) if request['action'] == 'download' else limit + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk: break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b''.join(chunks)
        after = os.fstat(fd)
        if (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('file_changed')
        if len(data) > limit:
            raise ValueError('file_too_large')
        next_offset = offset + len(data)
        print(json.dumps(dict(root=root, data=base64.b64encode(data).decode('ascii'), size=info.st_size, revision=revision, nextByteOffset=next_offset if next_offset < info.st_size else None)))
except ValueError as error:
    print(json.dumps(dict(error=str(error))))
except FileNotFoundError:
    print(json.dumps(dict(error='not_found')))
except OSError:
    print(json.dumps(dict(error='unreadable_path')))
finally:
    for fd in reversed(fds):
        os.close(fd)
`;

export function workspaceReaderCommand(
  input: WorkspaceRequest,
  root: string | null = "/home/user",
): string {
  const encoded = Buffer.from(
    JSON.stringify({
      action: input.action,
      path: input.path,
      search: input.search,
      offset: input.offset,
      byteOffset: input.byteOffset,
      revision: input.revision,
      limit:
        input.action === "preview"
          ? WORKSPACE_PREVIEW_LIMIT
          : WORKSPACE_DOWNLOAD_LIMIT,
    }),
  ).toString("base64");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return `python3 -c ${quote(WORKSPACE_READER_PYTHON)} ${quote(encoded)}${root ? ` ${quote(root)}` : ""}`;
}
