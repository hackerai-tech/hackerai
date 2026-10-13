// Runs inside the cloud sandbox. No authentication data or encryption keys are
// embedded in this program, its arguments, or its output.
export const BROWSER_SESSION_PROGRAM = String.raw`
import os, pathlib, shutil, stat, subprocess, sys, time

action, directory = sys.argv[1:3]
root = pathlib.Path(directory)
if root.parent != pathlib.Path('/dev/shm') or not root.name.startswith('hackerai-browser-'):
    raise RuntimeError('Invalid browser session directory')

def validate():
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError('Invalid browser session owner')

def cleanup():
    if not root.exists():
        return
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

if action == 'prepare':
    os.umask(0o077)
    root.mkdir(mode=0o700)
    (root / 'sockets').mkdir(mode=0o700)
    (root / 'state').mkdir(mode=0o700)
    (root / 'config.json').write_text('{}')
    try:
        # Survives worker termination; stops promptly after ordinary cleanup.
        subprocess.Popen([sys.executable, '-c', sys.argv[4], 'expire', directory, sys.argv[3]],
                         start_new_session=True, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         close_fds=True)
    except BaseException:
        shutil.rmtree(root)
        raise
elif action == 'expire':
    deadline = float(sys.argv[3])
    while root.exists() and time.time() < deadline:
        time.sleep(min(5, max(0, deadline - time.time())))
    cleanup()
elif action == 'cleanup':
    cleanup()
else:
    raise RuntimeError('Unknown browser session action')
`;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function browserSessionCommand(
  action: "prepare" | "cleanup",
  directory: string,
  expiresAt: number,
): string {
  const args = [BROWSER_SESSION_PROGRAM, action, directory];
  if (action === "prepare") {
    args.push(String(expiresAt / 1000), BROWSER_SESSION_PROGRAM);
  }
  return `python3 -c ${args.map(quote).join(" ")}`;
}
