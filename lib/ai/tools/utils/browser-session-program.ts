// Runs inside the cloud sandbox. No authentication data or encryption keys are
// embedded in this program, its arguments, or its output.
export const BROWSER_SESSION_PROGRAM = String.raw`
import fcntl, json, os, pathlib, shutil, socket, stat, subprocess, sys, time

action, directory = sys.argv[1:3]
root = pathlib.Path(directory)
if root.parent != pathlib.Path('/dev/shm') or not root.name.startswith('hackerai-browser-'):
    raise RuntimeError('Invalid browser session directory')
shim_root = pathlib.Path('/tmp') / root.name

def validate():
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError('Invalid browser session owner')

def ambient_idle_timeout():
    # Observe only this nonsensitive declaration, not daemon flags or effective state.
    raw = os.environ.get('AGENT_BROWSER_IDLE_TIMEOUT_MS')
    if raw is None: return 'unset'
    if len(raw) > 128: return 'unparsed'
    value = raw.strip()
    if value.startswith('+'): value = value[1:]
    if not value or any(c < '0' or c > '9' for c in value): return 'unparsed'
    timeout = int(value)
    if timeout > 18446744073709551615: return 'unparsed'
    return 'disabled' if timeout == 0 else 'lt_15m' if timeout < 900000 else '15m' if timeout == 900000 else 'gt_15m'

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
    if len(sys.argv) > 6 and sys.argv[6]:
        init_script = sys.argv[6]
        # This optional adapter requires agent-browser's native init-script and
        # user-agent actions. Legacy workspaces keep ordinary browsing intact.
        try:
            import re
            version = subprocess.run(['agent-browser','--version'],capture_output=True,text=True,timeout=5,check=True)
            match = re.search(r'agent-browser (\d+)\.(\d+)\.(\d+)',version.stdout)
            supported = match and tuple(map(int,match.groups())) >= (0,39,3)
        except Exception:
            supported = False
        if len(init_script) <= 16384 and supported:
            (root / 'cloudflare.js').write_text(init_script)
            (root / 'config.json').write_text(json.dumps({'initScripts':[str(root / 'cloudflare.js')]}))
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
import fcntl, hashlib, json, os, pathlib, sys, time
root = pathlib.Path(%r)
fd = os.open(str(root / 'gate.lock'), os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
while (root / 'paused').exists():
    fcntl.flock(fd, fcntl.LOCK_UN)
    time.sleep(0.2)
    fcntl.flock(fd, fcntl.LOCK_EX)
active = root / 'active-session'
verify = root / 'verify-required'
name = os.environ.get('AGENT_BROWSER_SESSION', 'default')
if name == 'default' and active.exists():
    name = active.read_text().strip()
args = []
skip_next = False
for arg in sys.argv[1:]:
    if skip_next:
        name = arg
        skip_next = False
    elif arg == '--session':
        skip_next = True
    elif arg.startswith('--session='):
        name = arg.split('=', 1)[1]
    else:
        args.append(arg)
if skip_next or not name or len(name) > 80 or any(c in name for c in '/\\x00\\r\\n'):
    raise RuntimeError('Invalid browser session name')
if verify.exists() and active.read_text().strip() != name:
    raise RuntimeError('Snapshot the current browser before changing sessions')
sys.argv = [sys.argv[0], '--session', name, *args]
active.write_text(name)
def write_receipt(filename, value):
    temporary = None
    created = False
    try:
        temporary = root / ('.wrapper-receipt-' + os.urandom(12).hex())
        fd = os.open(str(temporary), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        created = True
        with os.fdopen(fd, 'w') as output:
            __import__('json').dump(value, output)
        os.replace(temporary, root / filename)
    except Exception:
        pass
    finally:
        if temporary is not None and created:
            try:
                temporary.unlink(missing_ok=True)
            except Exception:
                pass


def invocation_idle_env():
    # The wrapped command's declaration, not the separate probe's environment
    # or the effective configuration of a possibly pre-existing daemon.
    raw = os.environ.get('AGENT_BROWSER_IDLE_TIMEOUT_MS')
    if raw is None: return 'unset'
    if len(raw) > 128: return 'unparsed'
    value = raw.strip()
    if value.startswith('+'): value = value[1:]
    if not value or any(c < '0' or c > '9' for c in value): return 'unparsed'
    timeout = int(value)
    if timeout > 18446744073709551615: return 'unparsed'
    return 'disabled' if timeout == 0 else 'lt_15m' if timeout < 900000 else '15m' if timeout == 900000 else 'gt_15m'

def record_wrapper(phase, status=None, executed=False):
    """Atomically record finite wrapper state without changing CLI admission or its result."""
    # Diagnostic only, in the existing private ephemeral root. Never store argv,
    # targets or output; the reader exports session equality, not its name.
    try:
        info = root.lstat()
        if not __import__('stat').S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            return
        action = 'other'
        option_prefix = False
        args = iter(sys.argv[1:])
        for arg in args:
            if arg == '--session':
                next(args, None)
            elif arg.startswith('--session='):
                continue
            elif arg.startswith('-'):
                option_prefix = True
                break  # Unknown option values must not be mistaken for actions.
            else:
                action = arg if arg in ('open', 'close') else 'other'
                break
        close_all = False
        if action == 'close':
            for arg in args:
                if arg == '--session':
                    next(args, None)
                elif arg == '--all':
                    close_all = True
                elif arg in ('--help', '-h'):
                    action = 'other'
        if sys.argv[3:] in (['--version'], ['-V']):
            action = 'version'
            option_prefix = False
        value = dict(v=1, open_receipt_support=1, close_receipt_support=1, close_all=close_all, session_key=__import__('hashlib').sha256(name.encode('utf-8')).hexdigest(), action=action, phase=phase,
                     exit=status, at=int(time.time() * 1000))
        if action == 'open':
            value.update(idle_env_version=1, idle_env=invocation_idle_env())
        # Root-scoped retained observations, not proof of browser startup or of
        # no execution. A later version check must not erase a returned CLI call.
        previous_fd = None
        try:
            previous_fd = os.open(str(root / 'wrapper-receipt.json'), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            previous_info = os.fstat(previous_fd)
            if not __import__('stat').S_ISREG(previous_info.st_mode) or previous_info.st_uid != os.getuid() or previous_info.st_mode & 0o077 or not 0 < previous_info.st_size <= 512:
                raise ValueError('Unavailable receipt')
            history = json.loads(os.read(previous_fd, 513)).get('history')
            if isinstance(history, list) and len(history) == 3 and type(history[0]) is int and history[0] == 1 and type(history[1]) is bool and type(history[2]) is bool and (not history[2] or history[1]):
                value['history'] = [1, history[1] or (executed and action != 'version'), history[2] or (executed and option_prefix)]
        except Exception:
            pass  # Legacy, missing and unreadable history remains unmeasured.
        finally:
            if previous_fd is not None: os.close(previous_fd)
        # Keep wrapped open/close observations even after version/other commands.
        # These are observations, not proof that a browser is still running.
        write_receipt('wrapper-receipt.json', value)
        if action == 'open':
            write_receipt('open-receipt.json', value)
        elif action == 'close':
            write_receipt('close-receipt.json', value)
    except Exception:
        pass

record_wrapper('started')
verify = root / 'verify-required'
# Keep the last successful terminal environment. Server inspections use a
# narrower launch environment and must not replace the handoff baseline.
# Session names are normalized above; checkpoint encryption does not route the
# browser and is omitted by the server's inspection calls.
environment = {key: value for key, value in os.environ.items()
               if key.startswith('AGENT_BROWSER_') and key not in
               ('AGENT_BROWSER_SESSION', 'AGENT_BROWSER_ENCRYPTION_KEY')}
environment_digest = hashlib.sha256(json.dumps(environment, sort_keys=True).encode()).hexdigest()
environment_path = root / 'runtime-env-hash'
if verify.exists():
    args = sys.argv[1:]
    # Only presentation flags are allowed on this one required snapshot. Other
    # global options can redirect the CLI or restart its existing daemon.
    snapshot_args = args[2:]  # --session and its normalized name are above.
    routing_changed = bool(os.environ.get('AGENT_BROWSER_NAMESPACE')) or any(
        os.environ.get(key) != str(root / leaf)
        for key, leaf in (('AGENT_BROWSER_SOCKET_DIR', 'sockets'), ('AGENT_BROWSER_CONFIG', 'config.json')))
    routing_changed = routing_changed or not environment_path.exists() or environment_path.read_text() != environment_digest
    if routing_changed or snapshot_args.count('snapshot') != 1 or any(
        arg not in ('snapshot', '-i', '--interactive', '-c', '--compact', '--json') for arg in snapshot_args):
        print('Browser handoff resumed; this command was not executed. Run agent-browser snapshot -i first in this same session with its original environment. Only interactive, compact and JSON output flags are supported until verification finishes. This is a handoff verification gate, not a socket failure; do not reload, switch sessions, or repair the browser.', file=sys.stderr)
        record_wrapper('completed', 75)
        sys.exit(75)
    result = __import__('subprocess').run([%r, *args], close_fds=True)
    if result.returncode == 0:
        verify.unlink(missing_ok=True)
    record_wrapper('completed', result.returncode, True)
    sys.exit(result.returncode)
result = __import__('subprocess').run([%r, *sys.argv[1:]], close_fds=True)
if result.returncode == 0 and os.environ.get('HACKERAI_BROWSER_INSPECTION') != '1':
    environment_path.write_text(environment_digest)
    environment_path.chmod(0o600)
record_wrapper('completed', result.returncode, True)
sys.exit(result.returncode)
''' % (str(root), real, real)
        path = gate_bin / 'agent-browser'
        path.write_text(wrapper)
        path.chmod(0o700)
        # Bash commands can call the real CLI by absolute path and skip PATH.
        # Guard each command in the E2B shell, including nested Bash scripts.
        # The wrapper remains the serialized gate for ordinary CLI calls.
        guard = '''_hackerai_browser_guard() {
  case "$1" in
    *agent-browser*)
      if [[ "$1" =~ (^|[[:space:]])/[^[:space:]]*/agent-browser([[:space:]]|$) ]]; then
        printf 'Use agent-browser from PATH so human handoff remains enforced.\\n' >&2
        exit 75
      fi
      while [[ -e %s ]]; do sleep 0.2; done
      ;;
  esac
}
trap '_hackerai_browser_guard "$BASH_COMMAND"' DEBUG
''' % str(root / 'paused')
        guard_path = shim_root / 'guard.sh'
        guard_path.write_text(guard)
        guard_path.chmod(0o700)
        try:
            # Initialize only this newly prepared private root, before bootstrap.
            with os.fdopen(os.open(str(root / 'wrapper-receipt.json'), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as output:
                json.dump({'history':[1,False,False]}, output)
        except Exception:
            pass  # Optional diagnostics cannot prevent browser preparation.
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
elif action == 'status':
    validate()
    name = (root / 'active-session').read_text().strip()
    if not name or len(name) > 80 or any(c in name for c in '/\x00\r\n'):
        raise RuntimeError('Invalid browser session name')
    path = root / 'sockets' / (name + '.sock')
    info = path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError('Browser daemon unavailable')
    # Query the existing daemon directly. Invoking the CLI can auto-start or
    # reconfigure it; a completion probe must never create or relaunch a browser.
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(2)
        connection.connect(str(path))
        connection.sendall(b'{"id":"handoff-status","action":"stream_status"}\n')
        with connection.makefile('rb') as response:
            line = response.readline(65537)
            if not line or len(line) > 65536:
                raise RuntimeError('Invalid browser status')
            result = json.loads(line)
            output = json.dumps(result)
            if isinstance(result, dict) and len(output) + 1 <= 65536:
                result['hackerai_env_idle_timeout'] = ambient_idle_timeout()
                observed = json.dumps(result)
                # Optional metadata must not push a valid status past its existing cap.
                if len(observed) + 1 <= 65536: output = observed
            print(output)
elif action == 'cloudflare':
    validate()
    request = json.loads(sys.stdin.read(65537))
    deadline = float(sys.argv[3])
    if time.time() >= deadline:
        raise RuntimeError('Browser ownership expired')
    ua = request['userAgent']
    original_ua = request['originalUserAgent']
    script = request['script']
    if not isinstance(original_ua,str) or not 1 <= len(original_ua) <= 1024 or any(ord(c) < 32 or ord(c) > 126 for c in original_ua) or not isinstance(script,str) or len(script) > 32768:
        raise RuntimeError('Invalid managed delivery')
    import signal
    def cancel(signum, frame):
        raise InterruptedError('Managed delivery cancelled')
    signal.signal(signal.SIGTERM, cancel)
    if not isinstance(ua, str) or not 1 <= len(ua) <= 1024 or any(ord(c) < 32 or ord(c) > 126 for c in ua):
        raise RuntimeError('Invalid browser user agent')
    fd = os.open(str(root / 'gate.lock'), os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    try:
        if (root / 'paused').exists() or (root / 'verify-required').exists() or time.time() >= deadline:
            raise RuntimeError('Browser is unavailable')
        name = (root / 'active-session').read_text().strip()
        if name != request['sessionName'] or not name or len(name) > 80 or any(c in name for c in '/\x00\r\n'):
            raise RuntimeError('Browser identity changed')
        path = root / 'sockets' / (name + '.sock')
        info = path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError('Browser unavailable')
        def call(command):
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(5)
                connection.connect(str(path))
                connection.sendall((json.dumps(command) + '\n').encode())
                with connection.makefile('rb') as response:
                    line = response.readline(32769)
                    if not line or len(line) > 32768:
                        raise RuntimeError('Invalid browser response')
                    result = json.loads(line)
                    if result.get('success') is not True:
                        raise RuntimeError('Browser operation failed')
                    return result.get('data', {})
        expected = json.dumps({'url':request['url'], 'documentId':request['documentId']})
        script = '(e => {const u=new URL(location.href); return !u.username && !u.password && !u.hash && [...u.searchParams.keys()].every(k=>/^__cf_chl_[A-Za-z0-9_]+$/.test(k)) && u.origin+u.pathname === e.url && String(performance.timeOrigin) === e.documentId})(' + expected + ')'
        if call({'id':'captcha-identity', 'action':'evaluate', 'script':script}).get('result') is not True:
            raise RuntimeError('Browser page changed')
        delivered = False
        try:
            call({'id':'captcha-useragent', 'action':'useragent', 'userAgent':ua})
            result = call({'id':'captcha-deliver', 'action':'evaluate', 'script':request['script']}).get('result')
            if not isinstance(result,dict) or result.get('status') not in ('page_changed','token_delivered'):
                raise RuntimeError('Invalid managed delivery result')
            delivered = result['status'] == 'token_delivered'
            print(json.dumps({'result':result}))
        finally:
            if not delivered:
                try:
                    call({'id':'captcha-restore-useragent','action':'useragent','userAgent':original_ua})
                except Exception:
                    pass  # Ownership cleanup still closes this run's browser.

    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
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
  action: "prepare" | "cleanup" | "pause" | "resume" | "status" | "cloudflare",
  directory: string,
  expiresAt: number,
  gate = false,
  initScript?: string,
): string {
  const args = [BROWSER_SESSION_PROGRAM, action, directory];
  if (action === "prepare") {
    args.push(String(expiresAt / 1000), BROWSER_SESSION_PROGRAM);
    args.push(gate ? "gate" : "", initScript ?? "");
  }
  if (action === "cloudflare") args.push(String(expiresAt / 1000));
  return `python3 -c ${args.map(quote).join(" ")}`;
}
