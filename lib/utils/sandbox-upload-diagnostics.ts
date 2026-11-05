import "server-only";
import type { AnySandbox } from "@/types";
import {
  runAttachmentCommand,
  throwIfAttachmentAborted,
} from "@/lib/ai/tools/utils/attachment-command";

// Numeric/boolean fields only; never return paths, usernames, or raw errors.
const WRITE_PROBE_SCRIPT = `import errno, json, os, signal, stat, sys, uuid
def stop(signum, frame):
    raise TimeoutError()
signal.signal(signal.SIGTERM, stop)
out = {"probe_status": "ok", "command_uid": os.geteuid(), "command_gid": os.getegid()}
target = sys.argv[1]
parent = os.path.dirname(target)
try:
    entry = os.lstat(target)
    out.update(target_exists=True, target_uid=entry.st_uid, target_gid=entry.st_gid,
               target_mode=stat.S_IMODE(entry.st_mode), target_writable=os.access(target, os.W_OK),
               target_type="symlink" if stat.S_ISLNK(entry.st_mode) else "file" if stat.S_ISREG(entry.st_mode) else "directory" if stat.S_ISDIR(entry.st_mode) else "other")
except FileNotFoundError:
    out["target_exists"] = False
except OSError:
    pass
directory = parent
while not os.path.isdir(directory):
    ancestor = os.path.dirname(directory)
    if ancestor == directory:
        break
    directory = ancestor
out["probe_directory_is_parent"] = directory == parent
try:
    entry = os.stat(directory)
    out.update(directory_uid=entry.st_uid, directory_gid=entry.st_gid,
               directory_mode=stat.S_IMODE(entry.st_mode), directory_writable=os.access(directory, os.W_OK))
    fs = os.statvfs(directory)
    out.update(available_bytes=fs.f_bavail * fs.f_frsize, available_inodes=fs.f_favail,
               filesystem_read_only=bool(fs.f_flag & os.ST_RDONLY))
except OSError:
    pass
probe = os.path.join(directory, ".hackerai-write-probe-" + uuid.uuid4().hex)
fd = None
created = False
try:
    fd = os.open(probe, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    created = True
    os.write(fd, b"0")
    out["write_probe_result"] = "writable"
except OSError as error:
    out["write_probe_errno"] = error.errno
    out["write_probe_result"] = {errno.EACCES: "permission_denied", errno.EPERM: "permission_denied", errno.ENOSPC: "disk_full", errno.EDQUOT: "quota_exceeded", errno.EROFS: "read_only"}.get(error.errno, "other_error")
finally:
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass
    if created:
        try:
            os.unlink(probe)
        except OSError:
            out["probe_cleanup_failed"] = True
print(json.dumps(out))`;

const NUMERIC_FIELDS = new Set([
  "command_uid",
  "command_gid",
  "target_uid",
  "target_gid",
  "target_mode",
  "directory_uid",
  "directory_gid",
  "directory_mode",
  "available_bytes",
  "available_inodes",
  "write_probe_errno",
]);
const BOOLEAN_FIELDS = new Set([
  "target_exists",
  "target_writable",
  "probe_directory_is_parent",
  "directory_writable",
  "filesystem_read_only",
  "probe_cleanup_failed",
]);
const ENUM_FIELDS: Record<string, readonly string[]> = {
  probe_status: ["ok"],
  target_type: ["file", "directory", "symlink", "other"],
  write_probe_result: [
    "writable",
    "permission_denied",
    "disk_full",
    "quota_exceeded",
    "read_only",
    "other_error",
  ],
};

export type UploadWriteDiagnostics = Record<string, number | boolean | string>;

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** Best effort, at most four seconds of command execution, same user as curl. */
export async function probeSandboxUploadWrite(
  sandbox: AnySandbox,
  localPath: string,
  signal?: AbortSignal,
): Promise<UploadWriteDiagnostics> {
  signal?.throwIfAborted();
  try {
    const result = await runAttachmentCommand(
      sandbox,
      `timeout --kill-after=1s 3s python3 -c ${quote(WRITE_PROBE_SCRIPT)} ${quote(localPath)}`,
      signal,
      { displayName: "", timeoutMs: 4_000 },
    );
    signal?.throwIfAborted();
    if (result.exitCode !== 0 || result.stdout.length > 4_096)
      return { probe_status: "unavailable" };
    const parsed: unknown = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { probe_status: "unavailable" };
    const safe: UploadWriteDiagnostics = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        (NUMERIC_FIELDS.has(key) &&
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0) ||
        (BOOLEAN_FIELDS.has(key) && typeof value === "boolean") ||
        (Object.hasOwn(ENUM_FIELDS, key) &&
          typeof value === "string" &&
          ENUM_FIELDS[key].includes(value))
      )
        safe[key] = value;
    }
    return safe.probe_status === "ok" &&
      typeof safe.command_uid === "number" &&
      typeof safe.command_gid === "number" &&
      typeof safe.write_probe_result === "string"
      ? safe
      : { probe_status: "unavailable" };
  } catch (error) {
    throwIfAttachmentAborted(signal, error);
    return { probe_status: "unavailable" };
  }
}
