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
real.write_text('#!/usr/bin/env python3\\nimport json,os,pathlib,sys\\nr=pathlib.Path('+repr(str(root))+')\\np=r/"wrapper-receipt.json"\\n(r/"observed.json").write_text(p.read_text() if p.is_file() else "null")\\n(r/"wrapper-pid").write_text(str(os.getppid()))\\nsys.exit('+str(x['exit'])+')\\n')
real.chmod(0o700)
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
result=subprocess.run(command,env=env,capture_output=True)
receipt=root/'wrapper-receipt.json'
observed=root/'observed.json'
print(json.dumps({'status':result.returncode,'started':json.loads(observed.read_text()) if observed.exists() else None,'started_bytes':len(observed.read_bytes()) if observed.exists() else None,'wrapper_pid':int((root/'wrapper-pid').read_text()) if (root/'wrapper-pid').exists() else None,'finished':json.loads(receipt.read_text()) if receipt.is_file() else None,'open':json.loads((root/'open-receipt.json').read_text()) if (root/'open-receipt.json').is_file() else None,'close':json.loads((root/'close-receipt.json').read_text()) if (root/'close-receipt.json').is_file() else None,'leftovers':len(list(root.glob('.wrapper-receipt-*'))),'verify_required':(root/'verify-required').exists()}))`,
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
