/**
 * Compare the complete persistent tree with a reviewed pristine-template
 * fingerprint. Never infer emptiness from a list of likely upload directories,
 * file timestamps, filename extensions, or a sandbox's own baseline file.
 * Only kernel pseudo-filesystems are omitted. Runtime noise is deliberately a
 * false negative: an unknown difference must never become permission to switch.
 */
export const EMPTY_WORKSPACE_PROBE_VERSION = 1;

export const EMPTY_WORKSPACE_PROBE = String.raw`
import hashlib, json, os, stat, sys, time

def fingerprint(root):
    deadline = time.monotonic() + 45
    digest = hashlib.sha256()
    count = 0
    total = 0
    link_groups = {}
    device = os.lstat(root).st_dev
    def walk_error(error):
        raise error
    def visit(path, relative):
        nonlocal count, total
        if time.monotonic() > deadline or count >= 250000:
            raise ValueError('limit')
        info = os.lstat(path)
        if info.st_dev != device:
            raise ValueError('mount')
        count += 1
        mode = stat.S_IFMT(info.st_mode)
        entry = [relative, info.st_mode, info.st_uid, info.st_gid, info.st_nlink]
        if stat.S_ISREG(mode):
            total += info.st_size
            if total > 16 * 1024 * 1024 * 1024:
                raise ValueError('limit')
            file_hash = hashlib.sha256()
            with open(path, 'rb') as source:
                while True:
                    if time.monotonic() > deadline:
                        raise ValueError('limit')
                    chunk = source.read(1024 * 1024)
                    if not chunk: break
                    file_hash.update(chunk)
            after = os.lstat(path)
            if (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('changed')
            entry.extend([info.st_size, file_hash.hexdigest()])
            # Stable path anchors preserve topology without comparing inode
            # numbers across different pristine template instances.
            entry.append(link_groups.setdefault((info.st_dev, info.st_ino), relative))
        elif stat.S_ISLNK(mode):
            entry.append(os.readlink(path))
        elif not stat.S_ISDIR(mode):
            raise ValueError('special_file')
        # Extended attributes (including capabilities/ACLs) are state too.
        entry.append([(name, os.getxattr(path, name, follow_symlinks=False).hex()) for name in sorted(os.listxattr(path, follow_symlinks=False))])
        digest.update(json.dumps(entry, separators=(',', ':'), ensure_ascii=True).encode() + b'\n')
        if stat.S_ISDIR(mode):
            before = os.listdir(path)
            for name in sorted(before):
                child = relative.rstrip('/') + '/' + name
                if child in ('/proc', '/sys', '/dev'):
                    # Reject symlink substitutions; never traverse virtual files.
                    virtual = os.path.join(path, name)
                    if not stat.S_ISDIR(os.lstat(virtual).st_mode) or not os.path.ismount(virtual):
                        raise ValueError('virtual_root')
                    if child == '/dev':
                        # E2B preserves memory too. Shared-memory/user files in
                        # /dev are not permission to discard state just because
                        # they are absent from the persistent disk fingerprint.
                        for current, dirs, files in os.walk(virtual, followlinks=False, onerror=walk_error):
                            if time.monotonic() > deadline:
                                raise ValueError('limit')
                            for item in files:
                                if stat.S_ISREG(os.lstat(os.path.join(current, item)).st_mode):
                                    raise ValueError('device_file')
                        shared = os.path.join(virtual, 'shm')
                        if os.path.isdir(shared) and os.listdir(shared):
                            raise ValueError('shared_memory')
                    continue
                visit(os.path.join(path, name), child)
            if sorted(before) != sorted(os.listdir(path)):
                raise ValueError('changed')
    visit(root, '/')
    return {'version': 1, 'digest': digest.hexdigest(), 'entries': count}

try:
    print(json.dumps(fingerprint(sys.argv[1] if len(sys.argv) > 1 else '/')))
except Exception:
    # Filenames, contents, provider secrets and exception text never leave the VM.
    print(json.dumps({'version': 1, 'unknown': True}))
    sys.exit(1)
`;

export const emptyWorkspaceProbeCommand = `/usr/bin/python3 -I -B -c '${EMPTY_WORKSPACE_PROBE.replaceAll("'", `'"'"'`)}'`;

export type EmptyWorkspaceFingerprint = {
  version: 1;
  digest: string;
  entries: number;
};

export function parseEmptyWorkspaceFingerprint(
  value: string,
): EmptyWorkspaceFingerprint | null {
  if (value.length > 256) return null;
  try {
    const parsed = JSON.parse(value);
    if (
      parsed.version !== EMPTY_WORKSPACE_PROBE_VERSION ||
      typeof parsed.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.digest) ||
      !Number.isSafeInteger(parsed.entries) ||
      parsed.entries < 1 ||
      parsed.entries > 250000 ||
      Object.keys(parsed).sort().join(",") !== "digest,entries,version"
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}
