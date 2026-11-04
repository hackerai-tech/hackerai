// Runs under the same flock as ordinary CLI commands and human takeover.
// No provider endpoint/key enters the sandbox. The old daemon stays open.
export const BROWSERLESS_ADOPT_PROGRAM = String.raw`
import fcntl, json, os, pathlib, socket, stat, subprocess, sys
root = pathlib.Path(sys.argv[1])
payload = json.load(sys.stdin)
stage = 'validation'
try:
    if root.parent != pathlib.Path('/dev/shm') or not root.name.startswith('hackerai-browser-'):
        raise ValueError()
    if not root.is_dir() or root.lstat().st_uid != os.getuid(): raise ValueError()
    name = payload['name']
    remote = payload['remoteName']
    if any(not isinstance(s, str) or not s or len(s) > 80 or any(c in s for c in '/\x00\r\n') for s in (name, remote)):
        raise ValueError()
    endpoint = payload['endpoint']
    import re
    if not re.fullmatch(r'ws://127\.0\.0\.1:[0-9]{1,5}/', endpoint): raise ValueError()
    fd = os.open(str(root / 'gate.lock'), os.O_CREAT | os.O_RDWR, 0o600)
    stage = 'ownership'
    fcntl.flock(fd, fcntl.LOCK_EX)
    if (root / 'paused').exists() or (root / 'verify-required').exists() or (root / 'fallback-session').exists(): raise ValueError()
    if (root / 'active-session').read_text().strip() != name: raise ValueError()
    address = root / 'sockets' / (name + '.sock')
    if not stat.S_ISSOCK(address.lstat().st_mode): raise ValueError()
    request = {'id': 'fallback-pin', 'action': 'evaluate', 'script':
      '({url:location.href,documentId:String(performance.timeOrigin)})'}
    stage = 'page_identity'
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(3)
        connection.connect(str(address))
        connection.sendall((json.dumps(request) + '\n').encode())
        with connection.makefile('rb') as stream:
            reply = json.loads(stream.readline(65537))
    observed = reply.get('data', {}).get('result', {})
    if reply.get('success') is not True or observed != payload['expected']: raise ValueError()
    if payload['phase'] == 'prepare':
        stage = 'remote_connect'
        env = dict(os.environ, AGENT_BROWSER_SOCKET_DIR=str(root / 'sockets'),
          AGENT_BROWSER_CONFIG=str(root / 'config.json'), AGENT_BROWSER_SESSION=remote)
        # Raw CLI here: the outer process already owns the command gate.
        result = subprocess.run(['agent-browser', '--session', remote, '--cdp', endpoint,
          'snapshot', '--json'], env=env, capture_output=True, timeout=12)
        if result.returncode != 0: raise ValueError()
    elif payload['phase'] == 'activate':
        stage = 'activation'
        remote_socket = root / 'sockets' / (remote + '.sock')
        if not stat.S_ISSOCK(remote_socket.lstat().st_mode): raise ValueError()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(3)
            connection.connect(str(remote_socket))
            connection.sendall((json.dumps({'id':'fallback-ready','action':'evaluate','script':'location.href'})+'\n').encode())
            with connection.makefile('rb') as stream:
                ready = json.loads(stream.readline(65537))
        if ready.get('success') is not True or ready.get('data',{}).get('result') != payload['expected']['url']:
            raise ValueError()
        # All readers/commands select the same remote daemon after the gate
        # opens. A takeover racing this transition rechecks active-session.
        (root / 'fallback-session.next').write_text(json.dumps({'name':remote,'original':name,'endpoint':endpoint}))
        os.chmod(root / 'fallback-session.next', 0o600)
        os.replace(root / 'fallback-session.next', root / 'fallback-session')
        (root / 'active-session.next').write_text(remote)
        os.replace(root / 'active-session.next', root / 'active-session')
        (root / 'verify-required').touch(mode=0o600)
    else: raise ValueError()
    print('{"adopted":true}')
except BaseException:
    print(json.dumps({'adopted':False,'stage':stage}))
    sys.exit(1)
`;

// Restore only this adoption, never a newer browser selection. Both directions
// require a fresh snapshot because references belong to different documents.
export const BROWSERLESS_RESTORE_PROGRAM = String.raw`
import fcntl, json, os, pathlib, stat, sys, time
root = pathlib.Path(sys.argv[1])
payload = json.load(sys.stdin)
try:
    if root.parent != pathlib.Path('/dev/shm') or not root.name.startswith('hackerai-browser-'):
        raise ValueError()
    if not root.exists():
        print('{"restored":true}')
        sys.exit(0)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid(): raise ValueError()
    name, remote = payload['name'], payload['remoteName']
    if any(not isinstance(s, str) or not s or len(s) > 80 or any(c in s for c in '/\x00\r\n') for s in (name, remote)):
        raise ValueError()
    # Publish closure before waiting: the next CLI command completes recovery
    # under the same lock if a long-running command outlives this bounded call.
    (root / ('closed-' + remote)).touch(mode=0o600)
    fd = os.open(str(root / 'gate.lock'), os.O_CREAT | os.O_RDWR, 0o600)
    deadline = time.monotonic() + 8
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                print('{"restored":false,"deferred":true}')
                sys.exit(0)
            time.sleep(0.1)
    fallback = root / 'fallback-session'
    if fallback.exists():
        selected = json.loads(fallback.read_text())
        if selected.get('name') != remote or selected.get('original') != name: raise ValueError()
        if (root / 'active-session').read_text().strip() not in (name, remote): raise ValueError()
        try:
            info = (root / 'sockets' / (name + '.sock')).lstat()
        except FileNotFoundError:
            pass  # The original daemon may have stopped while fallback ran.
        else:
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid(): raise ValueError()
        (root / 'verify-required').touch(mode=0o600)
        (root / 'active-session.next').write_text(name)
        os.replace(root / 'active-session.next', root / 'active-session')
        fallback.unlink()
    print('{"restored":true}')
except Exception:
    print('{"restored":false}')
    sys.exit(1)
`;
