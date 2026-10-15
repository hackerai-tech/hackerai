// Runs inside the cloud sandbox. No authentication data or encryption keys are
// embedded in this program, its arguments, or its output.
export const BROWSER_SESSION_PROGRAM = String.raw`
import fcntl, os, pathlib, shutil, stat, subprocess, sys, time

action, directory = sys.argv[1:3]
root = pathlib.Path(directory)
if root.parent != pathlib.Path('/dev/shm') or not root.name.startswith('hackerai-browser-'):
    raise RuntimeError('Invalid browser session directory')
shim_root = pathlib.Path('/tmp') / root.name

def validate():
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError('Invalid browser session owner')

def cleanup():
    try:
        if root.exists():
            try:
                validate()
            except FileNotFoundError:
                return
            env = dict(os.environ, AGENT_BROWSER_SOCKET_DIR=str(root / 'sockets'),
                       AGENT_BROWSER_CONFIG=str(root / 'config.json'))
            for name in ('AGENT_BROWSER_SESSION_NAME', 'AGENT_BROWSER_PROFILE', 'AGENT_BROWSER_STATE'):
                env.pop(name, None)
            try:
                subprocess.run(['agent-browser', 'close', '--all'], env=env,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=15, check=True)
            finally:
                # Erase checkpoints even if Chrome or its daemon is unresponsive.
                try:
                    shutil.rmtree(root)
                except FileNotFoundError:
                    pass  # Completion and the expiry watchdog can race.
    finally:
        if shim_root.exists():
            info = shim_root.lstat()
            if stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid():
                shutil.rmtree(shim_root)

if action == 'prepare':
    os.umask(0o077)
    root.mkdir(mode=0o700)
    (root / 'sockets').mkdir(mode=0o700)
    (root / 'state').mkdir(mode=0o700)
    (root / 'config.json').write_text('{}')
    if len(sys.argv) > 5 and sys.argv[5] == 'gate':
        real = shutil.which('agent-browser')
        if not real:
            raise RuntimeError('agent-browser unavailable')
        shim_root.mkdir(mode=0o700)
        gate_bin = shim_root / 'bin'
        gate_bin.mkdir(mode=0o700)
        # The wrapper holds the same flock for the entire CLI lifetime. The
        # server can only create the paused marker after the current command
        # exits; subsequent CLI invocations wait until explicit resume.
        wrapper = '''#!/usr/bin/env python3
import fcntl, os, pathlib, sys, time
root = pathlib.Path(%r)
fd = os.open(str(root / 'gate.lock'), os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
while (root / 'paused').exists():
    fcntl.flock(fd, fcntl.LOCK_UN)
    time.sleep(0.2)
    fcntl.flock(fd, fcntl.LOCK_EX)
name = os.environ.get('AGENT_BROWSER_SESSION', 'default')
for i, arg in enumerate(sys.argv[1:]):
    if arg == '--session' and i + 2 < len(sys.argv):
        name = sys.argv[i + 2]
    elif arg.startswith('--session='):
        name = arg.split('=', 1)[1]
if not name or len(name) > 80 or '/' in name or '\\x00' in name:
    raise RuntimeError('Invalid browser session name')
(root / 'active-session').write_text(name)
verify = root / 'verify-required'
if verify.exists():
    args = sys.argv[1:]
    if 'snapshot' not in args:
        print('Browser handoff resumed. Take a fresh snapshot and verify the page and signed-in identity, if any, before another browser action.', file=sys.stderr)
        sys.exit(75)
    result = __import__('subprocess').run([%r, *args], close_fds=True)
    if result.returncode == 0:
        verify.unlink(missing_ok=True)
    sys.exit(result.returncode)
sys.exit(__import__('subprocess').run([%r, *sys.argv[1:]], close_fds=True).returncode)
''' % (str(root), real, real)
        path = gate_bin / 'agent-browser'
        path.write_text(wrapper)
        path.chmod(0o700)
        subprocess.run([str(path), '--version'], env=os.environ,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=10, check=True)
    try:
        # Survives worker termination; stops promptly after ordinary cleanup.
        subprocess.Popen([sys.executable, '-c', sys.argv[4], 'expire', directory, sys.argv[3]],
                         start_new_session=True, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         close_fds=True)
    except BaseException:
        shutil.rmtree(root)
        shutil.rmtree(shim_root, ignore_errors=True)
        raise
    if len(sys.argv) > 5 and sys.argv[5] == 'gate':
        print(os.environ.get('PATH', ''))
elif action == 'expire':
    deadline = float(sys.argv[3])
    while root.exists() and time.time() < deadline:
        time.sleep(min(5, max(0, deadline - time.time())))
    cleanup()
elif action == 'cleanup':
    cleanup()
elif action in ('pause', 'resume'):
    validate()
    fd = os.open(str(root / 'gate.lock'), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        if action == 'pause':
            deadline = time.monotonic() + 8
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Browser command is busy')
                    time.sleep(0.1)
            (root / 'paused').touch(mode=0o600)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX)
            (root / 'verify-required').touch(mode=0o600)
            (root / 'paused').unlink(missing_ok=True)
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
else:
    raise RuntimeError('Unknown browser session action')
`;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Quote a sandbox lifecycle command without embedding authentication data. */
export function browserSessionCommand(
  action: "prepare" | "cleanup" | "pause" | "resume",
  directory: string,
  expiresAt: number,
  gate = false,
): string {
  const args = [BROWSER_SESSION_PROGRAM, action, directory];
  if (action === "prepare") {
    args.push(String(expiresAt / 1000), BROWSER_SESSION_PROGRAM);
    if (gate) args.push("gate");
  }
  return `python3 -c ${args.map(quote).join(" ")}`;
}
