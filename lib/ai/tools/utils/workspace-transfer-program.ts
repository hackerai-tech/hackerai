/** Runs only in the two fenced VMs. Paths, contents and per-file hashes never
 * leave them as diagnostics. The worker receives bounded aggregate results. */
export const WORKSPACE_TRANSFER_PROGRAM = String.raw`
import base64, hashlib, json, os, shutil, stat, sys, tarfile, time

MAX_BYTES = 12 * 1024**3
MAX_ARCHIVE = 4 * 1024**3
MAX_ENTRIES = 250000
deadline = time.monotonic() + 1200
operation, stage = sys.argv[1:3]
root = sys.argv[3] if len(sys.argv) > 3 else '/'
home = 'home/user'
safe_failures = {
    'changed', 'external_hardlink', 'external_symlink', 'limit', 'mount',
    'socket', 'unsupported_entry', 'unsupported_workspace_entry',
    'virtual_mount', 'workspace_mount', 'workspace_root'
}

def check():
    if time.monotonic() > deadline: raise ValueError('limit')

def file_hash(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        while True:
            check()
            block = source.read(1024 * 1024)
            if not block: break
            digest.update(block)
    return digest.hexdigest()

def attrs(path):
    return [(key, base64.b64encode(os.getxattr(path, key, follow_symlinks=False)).decode())
            for key in sorted(os.listxattr(path, follow_symlinks=False))]

def paths():
    if os.path.abspath(root) == '/':
        with open('/proc/self/mountinfo') as mounts:
            for line in mounts:
                fields = line.split()
                mount = fields[4]
                if mount == '/home' or mount == '/' + home or mount.startswith('/' + home + '/'):
                    raise ValueError('workspace_mount')
    def walk(path, name):
        check()
        if name in ('proc', 'sys') or os.path.abspath(path) == os.path.abspath(stage): return
        info = os.lstat(path)
        yield path, name, info
        if stat.S_ISDIR(info.st_mode):
            before = sorted(os.listdir(path))
            for child in before:
                yield from walk(os.path.join(path, child), name + '/' + child if name else child)
            if before != sorted(os.listdir(path)): raise ValueError('changed')
    # Agent-created and user-provided workspace state lives under /home/user.
    # Never copy the E2B base image, runtime logs, certificates, or other OS
    # files into a Miosa workspace.
    yield from walk(os.path.join(root, home), home)

def scan(archive=None):
    digest = hashlib.sha256()
    home_digest = hashlib.sha256()
    count = total = 0
    links = {}
    link_counts = {}
    expected_link_counts = {}
    for path, name, info in paths():
        if not name: continue
        count += 1
        if count > MAX_ENTRIES: raise ValueError('limit')
        in_home = name == home or name.startswith(home + '/')
        if name == home and not stat.S_ISDIR(info.st_mode): raise ValueError('workspace_root')
        if in_home and not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
            raise ValueError('unsupported_workspace_entry')
        if stat.S_ISSOCK(info.st_mode):
            if not name.startswith(('run/', 'dev/')): raise ValueError('socket')
            continue
        metadata = [name, info.st_mode, info.st_uid, info.st_gid, info.st_nlink, attrs(path)]
        if stat.S_ISREG(info.st_mode):
            total += info.st_size
            if total > MAX_BYTES: raise ValueError('limit')
            identity = (info.st_dev, info.st_ino)
            link_counts[identity] = link_counts.get(identity, 0) + 1
            expected_link_counts[identity] = info.st_nlink
            metadata += [info.st_size, file_hash(path), links.setdefault(identity, name)]
        elif stat.S_ISLNK(info.st_mode):
            target = os.readlink(path)
            metadata.append(target)
            if in_home:
                resolved = os.path.normpath(os.path.join('/' + os.path.dirname(name), target))
                if resolved != '/' + home and not resolved.startswith('/' + home + '/'): raise ValueError('external_symlink')
        elif stat.S_ISCHR(info.st_mode) or stat.S_ISBLK(info.st_mode):
            metadata.append(info.st_rdev)
        elif not (stat.S_ISDIR(info.st_mode) or stat.S_ISFIFO(info.st_mode)):
            raise ValueError('unsupported_entry')
        if archive:
            member = archive.gettarinfo(path, arcname=name)
            member.pax_headers['HACKERAI.xattrs'] = json.dumps(metadata[5], separators=(',', ':'))
            if member.isreg():
                with open(path, 'rb') as source: archive.addfile(member, source)
            else: archive.addfile(member)
        after = os.lstat(path)
        if stat.S_ISREG(info.st_mode) and (
            info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (
            after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('changed')
        encoded = json.dumps(metadata, separators=(',', ':'), ensure_ascii=True).encode() + b'\n'
        digest.update(encoded)
        if in_home: home_digest.update(encoded)
        if archive and os.path.getsize(os.path.join(stage, 'source.tar.gz')) > MAX_ARCHIVE: raise ValueError('limit')
    if any(link_counts[identity] != expected for identity, expected in expected_link_counts.items()):
        raise ValueError('external_hardlink')
    return {'version': 1, 'digest': digest.hexdigest(), 'homeDigest': home_digest.hexdigest(), 'entries': count, 'bytes': total}

def safe_parent(path, boundary):
    current = os.path.dirname(path)
    while current != boundary:
        if not current.startswith(boundary + '/') or os.path.islink(current): raise ValueError('unsafe_parent')
        current = os.path.dirname(current)

def restore():
    bundle = os.path.join(stage, 'source.tar.gz')
    extract = os.path.join(stage, 'restore')
    os.mkdir(extract, 0o700)
    os.mkdir(os.path.join(extract, 'home'), 0o700)
    members = []
    restored_bytes = 0
    with tarfile.open(bundle, 'r:gz') as archive:
        for member in archive:
            check()
            name = member.name
            if not (name == home or name.startswith(home + '/')): continue
            if len(members) >= MAX_ENTRIES: raise ValueError('limit')
            if name == home and not member.isdir(): raise ValueError('workspace_root')
            if name != os.path.normpath(name) or name.startswith('/') or '..' in name.split('/'):
                raise ValueError('unsafe_path')
            path = os.path.join(extract, name)
            safe_parent(path, extract)
            if os.path.lexists(path): raise ValueError('duplicate_path')
            if member.isdir(): os.mkdir(path, 0o700)
            elif member.isreg():
                restored_bytes += member.size
                if member.size < 0 or restored_bytes > MAX_BYTES or os.statvfs(extract).f_bavail * os.statvfs(extract).f_frsize < member.size + 256 * 1024**2:
                    raise ValueError('space')
                with archive.extractfile(member) as source, open(path, 'xb') as destination:
                    shutil.copyfileobj(source, destination, 1024 * 1024)
            elif member.issym():
                resolved = os.path.normpath(os.path.join('/' + os.path.dirname(name), member.linkname))
                if resolved != '/' + home and not resolved.startswith('/' + home + '/'): raise ValueError('external_symlink')
                os.symlink(member.linkname, path)
            elif member.islnk():
                if member.linkname != os.path.normpath(member.linkname) or not member.linkname.startswith(home + '/'):
                    raise ValueError('external_hardlink')
                target = os.path.join(extract, member.linkname)
                safe_parent(target, extract)
                if not stat.S_ISREG(os.lstat(target).st_mode): raise ValueError('unsafe_link')
                os.link(target, path, follow_symlinks=False)
            else: raise ValueError('unsupported_entry')
            members.append((path, member))
    for path, member in reversed(members):
        os.chown(path, member.uid, member.gid, follow_symlinks=False)
        if not member.issym(): os.chmod(path, member.mode)
        for key, value in json.loads(member.pax_headers.get('HACKERAI.xattrs', '[]')):
            os.setxattr(path, key, base64.b64decode(value, validate=True), follow_symlinks=False)
        os.utime(path, (member.mtime, member.mtime), follow_symlinks=False)
    return extract

try:
    if operation == 'export':
        os.mkdir(stage, 0o700)
        with tarfile.open(os.path.join(stage, 'source.tar.gz'), 'w:gz', format=tarfile.PAX_FORMAT, compresslevel=1) as archive:
            result = scan(archive)
        result['archiveDigest'] = file_hash(os.path.join(stage, 'source.tar.gz'))
        result['archiveBytes'] = os.path.getsize(os.path.join(stage, 'source.tar.gz'))
        if result['archiveBytes'] > MAX_ARCHIVE: raise ValueError('limit')
        print(json.dumps(result))
    elif operation in ('verify-source', 'verify-home'):
        result = scan()
        print(json.dumps(result))
    elif operation == 'restore':
        result = {'archiveDigest': file_hash(os.path.join(stage, 'source.tar.gz'))}
        extract = restore()
        previous_root = root
        root = extract
        # Scan only the extracted home with identical relative path anchors.
        result['homeDigest'] = scan()['homeDigest']
        root = previous_root
        print(json.dumps(result))
    elif operation == 'install':
        live = os.path.join(root, home)
        if os.path.islink(live): raise ValueError('unsafe_home')
        os.rename(live, os.path.join(stage, 'miosa-original-home'))
        os.rename(os.path.join(stage, 'restore', home), live)
        print(json.dumps({'installed': True}))
    else: raise ValueError('operation')
except Exception as error:
    failure = str(error) if isinstance(error, ValueError) and str(error) in safe_failures else (
        'filesystem_unavailable' if isinstance(error, OSError) else 'unexpected')
    print(json.dumps({'failure': failure}))
    sys.exit(1)
`;

export const transferCommand = (
  operation: "export" | "verify-source" | "verify-home" | "restore" | "install",
  stage: string,
) => {
  if (!/^\/\.hackerai-migration-[a-f0-9-]{36}$/.test(stage))
    throw new Error("Invalid migration stage");
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  return `/usr/bin/python3 -I -B -c ${quote(WORKSPACE_TRANSFER_PROGRAM)} ${operation} ${quote(stage)}`;
};
