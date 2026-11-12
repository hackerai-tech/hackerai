import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER_SESSION_PROGRAM } from "../browser-session-program";

/**
 * Run the generated wrapper with only its own /proc/self/stat open replaced by
 * a synthetic stat line ({pid} becomes the wrapper PID); empty means unavailable.
 * Optionally, closing that descriptor fails after it is actually closed.
 */
const PROC_STAT_BOOTSTRAP = String.raw`import os,runpy,sys
script,stat,close_fails=sys.argv[1:4]
sys.argv=[script,*sys.argv[4:]]
real_open,real_close=os.open,os.close
stat_fds=set()
def controlled_open(path,*args,**kwargs):
    if path!='/proc/self/stat': return real_open(path,*args,**kwargs)
    if not stat: raise FileNotFoundError(path)
    fixture=script+'.stat'
    with open(fixture,'w',encoding='latin-1') as output: output.write(stat.replace('{pid}',str(os.getpid())))
    fd=real_open(fixture,*args,**kwargs)
    stat_fds.add(fd)
    return fd
def controlled_close(fd):
    real_close(fd)
    if close_fails and fd in stat_fds:
        stat_fds.discard(fd)
        raise OSError('PRIVATE close failure')
os.open,os.close=controlled_open,controlled_close
runpy.run_path(script,run_name='__main__')
`;

/**
 * Run the generated wrapper with lstat of the private sockets directory
 * ("sockets:kind") or a selected socket ("socket:kind") failing.
 */
const LSTAT_FAULT_BOOTSTRAP = String.raw`import errno,pathlib,runpy,sys
script,fault=sys.argv[1:3]
sys.argv=[script,*sys.argv[3:]]
target,kind=fault.split(':')
real_lstat=pathlib.Path.lstat
def controlled_lstat(self):
    hit=self.name=='sockets' if target=='sockets' else self.name.endswith('.sock')
    if not hit: return real_lstat(self)
    if kind=='permission': raise PermissionError(errno.EACCES,'PRIVATE lstat failure')
    if kind=='io': raise OSError(errno.EIO,'PRIVATE lstat failure')
    raise RuntimeError('PRIVATE diagnostic failure')
pathlib.Path.lstat=controlled_lstat
runpy.run_path(script,run_name='__main__')
`;

/**
 * Controlled CLI: snapshots what the wrapper wrote before it ran, creates the
 * requested socket fixture for its selected session, writes fixed output, exits.
 */
const FAKE_BROWSER = String.raw`#!/usr/bin/env python3
import os,pathlib,socket,sys
r=pathlib.Path({root})
for source,target in (('wrapper-receipt.json','observed.json'),('open-receipt.json','observed-open.json')):
    p=r/source
    (r/target).write_text(p.read_text() if p.is_file() else 'null')
(r/'wrapper-pid').write_text(str(os.getppid()))
f=r/'socket-fixture'
m=f.read_text() if f.is_file() else ''
if m:
    n=sys.argv[2]+'.sock'
    # Relative binds avoid the platform AF_UNIX path-length limit.
    os.chdir(r/('real-sockets' if 'symlink' in m else 'sockets'))
    if os.path.lexists(n): os.unlink(n)  # A previous call's fixture.
    if m=='file': open(n,'w').close()
    elif m!='missing':
        s=socket.socket(socket.AF_UNIX)
        s.bind(n)
        s.close()
        if m=='symlink': os.symlink(os.path.abspath(n),str(r/'sockets'/n))
print('CLI_OUT',flush=True)
print('CLI_ERR',file=sys.stderr,flush=True)
if {exit}<0: os.kill(os.getpid(),-({exit}))
sys.exit({exit})
`;

type SocketFixture =
  | "socket"
  | "socket_removed"
  | "missing"
  | "file"
  | "symlink"
  | "public_parent"
  | "parent_symlink";

/** Execute the generated wrapper with a controlled CLI, without a browser or watchdog. */
const exercise = (
  root: string,
  exitCode: number,
  blockedReceipt = false,
  args = ["--session", "PRIVATE_SESSION", "open", "PRIVATE_TARGET"],
  verify = false,
  idleEnv?: string,
  initializeHistory = true,
  procStat?: string | false,
  procStatCloseFails = false,
  { socket, lstatFault }: { socket?: SocketFixture; lstatFault?: string } = {},
) =>
  JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `import ast,json,os,pathlib,subprocess,sys
x=json.load(sys.stdin)
os.environ.pop('AGENT_BROWSER_IDLE_TIMEOUT_MS',None)
if x.get('idleEnv') is not None: os.environ['AGENT_BROWSER_IDLE_TIMEOUT_MS']=x['idleEnv']
root=pathlib.Path(x['root'])
if x['initializeHistory'] and not x['blocked'] and not (root/'wrapper-receipt.json').exists():
    (root/'wrapper-receipt.json').write_text(json.dumps({'history':[1,False,False]}))
    (root/'wrapper-receipt.json').chmod(0o600)
real=root/'fake-browser'
real.write_text(x['fake'].replace('{root}',repr(str(root))).replace('{exit}',str(x['exit'])))
real.chmod(0o700)
mode=x.get('socket') or ''
sockets=root/'sockets'
if mode: (root/'socket-fixture').write_text(mode)
else: (root/'socket-fixture').unlink(missing_ok=True)
if 'symlink' in mode: (root/'real-sockets').mkdir(mode=0o700,exist_ok=True)
if mode=='parent_symlink':
    if not sockets.is_symlink(): sockets.symlink_to(root/'real-sockets')
elif mode:
    sockets.mkdir(mode=0o700,exist_ok=True)
    sockets.chmod(0o755 if mode=='public_parent' else 0o700)
if x['blocked']: (root/'wrapper-receipt.json').mkdir()
tree=ast.parse(x['program'])
assignment=next(n for n in ast.walk(tree) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='wrapper' for t in n.targets))
wrapper=assignment.value.left.value % (str(root),str(real),str(real))
script=root/'wrapper'
script.write_text(wrapper)
env={**os.environ,'AGENT_BROWSER_SESSION':'default','AGENT_BROWSER_SOCKET_DIR':str(root/'sockets'),'AGENT_BROWSER_CONFIG':str(root/'config.json')}
if x['verify']:
    # Resume verification follows a successful call in the same browser environment.
    subprocess.run([sys.executable,str(script),'snapshot','-i'],env=env,capture_output=True,check=True)
    (root/'observed.json').unlink()
    (root/'verify-required').touch()
command=[sys.executable,str(script),*x['args']]
if x.get('procStat') is not None: command=[sys.executable,'-c',x['bootstrap'],str(script),x['procStat'] or '','1' if x['procStatCloseFails'] else '',*x['args']]
if x.get('lstatFault'): command=[sys.executable,'-c',x['lstatBootstrap'],str(script),x['lstatFault'],*x['args']]
result=subprocess.run(command,env=env,capture_output=True)
if mode=='socket_removed':
    for path in sockets.glob('*.sock'): path.unlink()
receipt=root/'wrapper-receipt.json'
observed=root/'observed.json'
observed_open=root/'observed-open.json'
print(json.dumps({'status':result.returncode,'stdout':result.stdout.decode(),'stderr':result.stderr.decode(),'started_open':json.loads(observed_open.read_text()) if observed_open.exists() else None,'socket_count':len(list(sockets.glob('*.sock'))) if sockets.is_dir() else None,'started':json.loads(observed.read_text()) if observed.exists() else None,'started_bytes':len(observed.read_bytes()) if observed.exists() else None,'wrapper_pid':int((root/'wrapper-pid').read_text()) if (root/'wrapper-pid').exists() else None,'finished':json.loads(receipt.read_text()) if receipt.is_file() else None,'open':json.loads((root/'open-receipt.json').read_text()) if (root/'open-receipt.json').is_file() else None,'close':json.loads((root/'close-receipt.json').read_text()) if (root/'close-receipt.json').is_file() else None,'leftovers':len(list(root.glob('.wrapper-receipt-*'))),'verify_required':(root/'verify-required').exists()}))`,
      ],
      {
        input: JSON.stringify({
          root,
          exit: exitCode,
          blocked: blockedReceipt,
          args,
          verify,
          idleEnv,
          initializeHistory,
          procStat,
          procStatCloseFails,
          bootstrap: PROC_STAT_BOOTSTRAP,
          socket,
          lstatFault,
          lstatBootstrap: LSTAT_FAULT_BOOTSTRAP,
          fake: FAKE_BROWSER,
          program: BROWSER_SESSION_PROGRAM,
        }),
        encoding: "utf8",
      },
    ),
  );

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "hackerai-wrapper-receipt-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it.each([
  [undefined, "unset"],
  ["0", "disabled"],
  ["1", "lt_15m"],
  [" +900000 ", "15m"],
  ["900001", "gt_15m"],
  ["PRIVATE_ENV", "unparsed"],
  ["-1", "unparsed"],
  ["1e6", "unparsed"],
  ["18446744073709551616", "unparsed"],
  ["9".repeat(129), "unparsed"],
])(
  "records only the actual wrapped open idle declaration (%#)",
  (idleEnv, bucket) => {
    const opened = exercise(root, 37, false, undefined, false, idleEnv);
    expect(opened.status).toBe(37);
    expect(opened.open).toMatchObject({
      idle_env: bucket,
      idle_env_version: 1,
    });
    expect(Buffer.byteLength(JSON.stringify(opened.open))).toBeLessThanOrEqual(
      512,
    );
    const later = exercise(root, 0, false, ["--version"], false, "0");
    expect(later.open).toEqual(opened.open);
    expect(JSON.stringify(later)).not.toContain("PRIVATE_ENV");
  },
);

it.each([0, 37])(
  "observes start/completion without replacing browser exit %s or recording arguments",
  (exitCode) => {
    const result = exercise(root, exitCode);
    expect(result.status).toBe(exitCode);
    expect(result.started).toMatchObject({
      v: 1,
      action: "open",
      phase: "started",
      exit: null,
    });
    expect(result.finished).toMatchObject({
      v: 1,
      action: "open",
      phase: "completed",
      exit: exitCode,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_TARGET");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SESSION");
    expect(result.leftovers).toBe(0);
  },
);

it("preserves the CLI result and removes only its own temporary file when diagnostics cannot be written", () => {
  const result = exercise(root, 37, true);
  expect(result.status).toBe(37);
  expect(result.finished).toBeNull();
  expect(result.leftovers).toBe(0);
});

it.each([
  [["--version"], "version"],
  [["--session=PRIVATE_SESSION", "close", "--all"], "close"],
  [["--proxy", "open", "snapshot"], "other"],
] as const)("records an unambiguous finite action for %j", (args, action) => {
  expect(exercise(root, 0, false, [...args]).finished.action).toBe(action);
});

it("retains the verification gate and preserves successful snapshot admission", () => {
  const blocked = exercise(root, 0, false, ["open", "PRIVATE_TARGET"], true);
  expect(blocked.status).toBe(75);
  expect(blocked.started).toBeNull(); // CLI was not admitted.
  expect(blocked.finished).toMatchObject({ phase: "completed", exit: 75 });
  expect(blocked.verify_required).toBe(true);
  const resumed = exercise(root, 0, false, ["snapshot", "-i"]);
  expect(resumed.status).toBe(0);
  expect(resumed.started.phase).toBe("started");
  expect(resumed.verify_required).toBe(false);
});

it("retains the latest wrapped open after a version check without retaining arguments", () => {
  const opened = exercise(root, 37);
  expect(opened.open).toMatchObject({
    action: "open",
    phase: "completed",
    exit: 37,
  });
  const version = exercise(root, 0, false, ["--version"]);
  expect(version.finished).toMatchObject({
    action: "version",
    open_receipt_support: 1,
  });
  expect(version.open).toEqual(opened.open);
  expect(JSON.stringify(version.open)).not.toMatch(
    /PRIVATE_TARGET|PRIVATE_SESSION/,
  );
  expect(version.leftovers).toBe(0);
});

it("retains a blocked-open observation without admitting the CLI or bypassing snapshot verification", () => {
  const blocked = exercise(root, 0, false, ["open", "PRIVATE_TARGET"], true);
  expect(blocked.open).toMatchObject({
    action: "open",
    phase: "completed",
    exit: 75,
  });
  const version = exercise(root, 0, false, ["--version"]);
  expect(version.status).toBe(75);
  expect(version.open).toEqual(blocked.open);
  expect(version.verify_required).toBe(true);
});

it("retains a close across other commands and a later reopen without replacing either CLI result", () => {
  const opened = exercise(root, 0);
  const closed = exercise(root, 37, false, [
    "--session",
    "PRIVATE_SESSION",
    "close",
  ]);
  expect(closed.status).toBe(37);
  expect(closed.close).toMatchObject({
    action: "close",
    phase: "completed",
    exit: 37,
  });
  expect(closed.open).toEqual(opened.open);
  for (const args of [["--version"], ["snapshot", "-i"]]) {
    const later = exercise(root, 0, false, args);
    expect(later.close).toEqual(closed.close);
    expect(later.finished.close_receipt_support).toBe(1);
  }
  const reopened = exercise(root, 17);
  expect(reopened.status).toBe(17);
  expect(reopened.open.exit).toBe(17);
  expect(reopened.close).toEqual(closed.close);
  expect(JSON.stringify(reopened.close)).not.toMatch(
    /PRIVATE_TARGET|PRIVATE_SESSION/,
  );
  expect(reopened.leftovers).toBe(0);
});

it("records close-all scope without mistaking a session argument for the flag", () => {
  const one = exercise(root, 0, false, ["close", "--session", "--all"]);
  expect(one.close.close_all).toBe(false);
  const all = exercise(root, 0, false, [
    "--session",
    "PRIVATE_SESSION",
    "close",
    "--all",
  ]);
  expect(all.close.close_all).toBe(true);
  expect(JSON.stringify(all.close)).not.toContain("PRIVATE_SESSION");
});

it("does not replace the retained close with a help-only invocation", () => {
  const closed = exercise(root, 0, false, ["close"]);
  const help = exercise(root, 0, false, ["close", "--help"]);
  expect(help.status).toBe(0);
  expect(help.finished.action).toBe("other");
  expect(help.close).toEqual(closed.close);
});

it("retains completed non-version and ambiguous-option observations across version checks and session changes", () => {
  expect(exercise(root, 0, false, ["--version"]).finished.history).toEqual([
    1,
    false,
    false,
  ]);
  const other = exercise(root, 37, false, [
    "--headed",
    "open",
    "PRIVATE_TARGET",
  ]);
  expect(other.status).toBe(37);
  expect(other.finished.action).toBe("other");
  expect(other.finished.history).toEqual([1, true, true]);
  const later = exercise(root, 0, false, [
    "--session",
    "OTHER_PRIVATE_SESSION",
    "--version",
  ]);
  expect(later.finished.history).toEqual([1, true, true]);
  expect(JSON.stringify(later)).not.toMatch(/PRIVATE_TARGET|PRIVATE_SESSION/);
});

it("does not count an option-prefixed CLI request blocked by resume verification as completed", () => {
  const blocked = exercise(
    root,
    0,
    false,
    ["--headed", "open", "PRIVATE_TARGET"],
    true,
  );
  expect(blocked.status).toBe(75);
  expect(blocked.started).toBeNull();
  // The fixture's successful snapshot ran, but the option-prefixed command did not.
  expect(blocked.finished.history).toEqual([1, true, false]);
  expect(blocked.verify_required).toBe(true);
});

it("keeps uninitialized legacy history unmeasured instead of inventing a negative observation", () => {
  const legacy = exercise(
    root,
    0,
    false,
    ["--version"],
    false,
    undefined,
    false,
  );
  expect(legacy.finished).not.toHaveProperty("history");
  const later = exercise(root, 37, false, ["snapshot", "-i"]);
  expect(later.status).toBe(37);
  expect(later.finished).not.toHaveProperty("history");
});

/** Synthetic stat line: state is field 3 and start ticks field 22. */
const statLine = (ticks: string, head = "{pid} (x) Z 9 (y)") =>
  `${head} S ${Array.from({ length: 18 }, (_, i) => i + 1).join(" ")} ${ticks} 0 0\n`;
const defaultArgs = ["--session", "PRIVATE_SESSION", "open", "PRIVATE_TARGET"];

it("records the private exact wrapper incarnation only while the CLI runs", () => {
  const result = exercise(
    root,
    37,
    false,
    defaultArgs,
    false,
    undefined,
    true,
    statLine("987654321"),
  );
  expect(result.status).toBe(37);
  expect(result.started).toMatchObject({ phase: "started", action: "open" });
  // The last ')' ends the command name, so its spoofed state/fields are ignored.
  expect(result.started.process).toEqual([1, result.wrapper_pid, "987654321"]);
  expect(result.finished).toMatchObject({ phase: "completed", exit: 37 });
  expect(result.finished).not.toHaveProperty("process");
  expect(result.open).not.toHaveProperty("process");
  expect(result.leftovers).toBe(0);
});

it("keeps a started receipt with a maximal identity within the private 512-byte reader cap", () => {
  const result = exercise(
    root,
    0,
    false,
    defaultArgs,
    false,
    "PRIVATE_ENV",
    true,
    statLine("18446744073709551615"),
  );
  expect(result.started.process).toEqual([
    1,
    result.wrapper_pid,
    "18446744073709551615",
  ]);
  expect(result.started).toMatchObject({
    idle_env: "unparsed",
    history: [1, false, false],
  });
  expect(result.started_bytes).toBeLessThanOrEqual(512);
});

it.each([
  ["unavailable", false],
  ["non-numeric start", statLine("PRIVATE")],
  ["start beyond uint64", statLine("18446744073709551616")],
  ["another PID", statLine("1", "1 (python3)")],
  ["missing command delimiter", statLine("1", "{pid} python3")],
  ["truncated", "{pid} (python3) S 1 2 3\n"],
  ["oversized", statLine("1") + " ".repeat(4097)],
] as const)(
  "omits only the identity when own process stat is %s and preserves the CLI result",
  (_case, procStat) => {
    const result = exercise(
      root,
      37,
      false,
      defaultArgs,
      false,
      undefined,
      true,
      procStat,
    );
    expect(result.status).toBe(37);
    expect(result.started).toMatchObject({
      v: 1,
      action: "open",
      phase: "started",
      exit: null,
      history: [1, false, false],
    });
    expect(result.started).not.toHaveProperty("process");
    expect(result.finished).toMatchObject({ phase: "completed", exit: 37 });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(result.leftovers).toBe(0);
  },
);

it("still writes the started receipt and CLI result when closing own process stat fails", () => {
  const result = exercise(
    root,
    37,
    false,
    defaultArgs,
    false,
    undefined,
    true,
    statLine("987654321"),
    true,
  );
  expect(result.status).toBe(37);
  // A close failure omits only the optional identity, never the receipt itself.
  expect(result.started).toMatchObject({
    v: 1,
    action: "open",
    phase: "started",
    exit: null,
    history: [1, false, false],
  });
  expect(result.started).not.toHaveProperty("process");
  expect(result.finished).toMatchObject({ phase: "completed", exit: 37 });
  expect(result.open).toMatchObject({ phase: "completed", exit: 37 });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(result.leftovers).toBe(0);
});

/** Run a wrapped CLI call with a controlled selected-socket fixture or lstat fault. */
const socketCall = (
  options: { socket?: SocketFixture; lstatFault?: string },
  exitCode = 0,
  args = defaultArgs,
) =>
  exercise(
    root,
    exitCode,
    false,
    args,
    false,
    undefined,
    true,
    undefined,
    false,
    options,
  );

it("records an owned socket at the successful OPEN return even if it disappears before capture", () => {
  const result = socketCall({ socket: "socket_removed" });
  expect(result.status).toBe(0);
  expect(result.socket_count).toBe(0); // A later capture would see it missing.
  expect(result.open).toMatchObject({
    action: "open",
    phase: "completed",
    exit: 0,
    os1: 1,
  });
  // The STARTED record and the latest-command receipt never carry it.
  expect(result.started_open).toMatchObject({ phase: "started" });
  expect(result.started_open).not.toHaveProperty("os1");
  expect(result.finished).not.toHaveProperty("os1");
  expect([result.stdout, result.stderr]).toEqual(["CLI_OUT\n", "CLI_ERR\n"]);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|\.sock|\/sockets/);
  expect(result.leftovers).toBe(0);
});

it.each<[SocketFixture | undefined, number]>([
  ["socket", 1],
  ["missing", 2],
  [undefined, 3], // The private sockets directory itself is missing.
  ["file", 3],
  ["symlink", 3],
  ["public_parent", 3],
  ["parent_symlink", 3],
])(
  "classifies the selected socket fixture %s at a successful OPEN return",
  (socket, code) => {
    const result = socketCall({ socket });
    expect(result.status).toBe(0);
    expect(result.open).toMatchObject({
      phase: "completed",
      exit: 0,
      os1: code,
    });
    expect([result.stdout, result.stderr]).toEqual(["CLI_OUT\n", "CLI_ERR\n"]);
  },
);

it("measures only the selected session's socket and replaces it with each later OPEN", () => {
  expect(socketCall({ socket: "socket" }).open.os1).toBe(1);
  const otherSession = [
    "--session",
    "OTHER_PRIVATE_SESSION",
    "open",
    "PRIVATE_TARGET",
  ];
  const other = socketCall({ socket: "missing" }, 0, otherSession);
  expect(other.socket_count).toBe(1); // The first session's socket remains.
  expect(other.open.os1).toBe(2);
  const failed = socketCall({ socket: "socket" }, 37);
  expect(failed.status).toBe(37);
  expect(failed.open).toMatchObject({ exit: 37 });
  expect(failed.open).not.toHaveProperty("os1");
  expect(JSON.stringify([other, failed])).not.toContain("PRIVATE");
});

it.each<[string, number, string[]]>([
  ["a failed OPEN", 37, defaultArgs],
  ["a signal-terminated OPEN", -15, defaultArgs],
  ["an option-prefixed OPEN", 0, ["--headed", "open", "PRIVATE_TARGET"]],
  ["a snapshot", 0, ["snapshot", "-i"]],
  ["a close", 0, ["close"]],
  ["a version check", 0, ["--version"]],
])("does not observe the socket after %s", (_case, exitCode, args) => {
  // The owned socket exists, so any inspection would have recorded os1=1.
  const result = socketCall({ socket: "socket" }, exitCode, args);
  expect(result.socket_count).toBe(1);
  if (exitCode >= 0) expect(result.status).toBe(exitCode);
  else expect(result.open).toMatchObject({ phase: "completed", exit: -15 });
  for (const receipt of [result.finished, result.open, result.close])
    expect(receipt ?? {}).not.toHaveProperty("os1");
  expect([result.stdout, result.stderr]).toEqual(["CLI_OUT\n", "CLI_ERR\n"]);
});

it("does not observe the socket for an OPEN refused by resume verification", () => {
  const blocked = exercise(root, 0, false, ["open", "PRIVATE_TARGET"], true);
  expect(blocked.status).toBe(75);
  expect(blocked.open).toMatchObject({ phase: "completed", exit: 75 });
  expect(blocked.open).not.toHaveProperty("os1");
});

it.each([
  ["sockets:permission", 4],
  ["sockets:io", 4],
  ["socket:permission", 4],
  ["socket:io", 4],
  ["sockets:runtime", 0],
  ["socket:runtime", 0],
])(
  "keeps the receipt and exact CLI result when lstat fails (%s)",
  (lstatFault, code) => {
    const result = socketCall({ socket: "socket", lstatFault }, 0);
    expect(result.status).toBe(0);
    expect([result.stdout, result.stderr]).toEqual(["CLI_OUT\n", "CLI_ERR\n"]);
    expect(result.finished).toMatchObject({ phase: "completed", exit: 0 });
    expect(result.open).toMatchObject({
      phase: "completed",
      exit: 0,
      os1: code,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(result.leftovers).toBe(0);
  },
);
