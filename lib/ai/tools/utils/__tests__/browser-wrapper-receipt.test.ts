import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER_SESSION_PROGRAM } from "../browser-session-program";

/** Execute the generated wrapper with a controlled CLI, without a browser or watchdog. */
const exercise = (
  root: string,
  exitCode: number,
  blockedReceipt = false,
  args = ["--session", "PRIVATE_SESSION", "open", "PRIVATE_TARGET"],
  verify = false,
  idleEnv?: string,
  initializeHistory = true,
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
real.write_text('#!/usr/bin/env python3\\nimport json,pathlib,sys\\nr=pathlib.Path('+repr(str(root))+')\\np=r/"wrapper-receipt.json"\\n(r/"observed.json").write_text(p.read_text() if p.is_file() else "null")\\nsys.exit('+str(x['exit'])+')\\n')
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
result=subprocess.run([sys.executable,str(script),*x['args']],env=env,capture_output=True)
receipt=root/'wrapper-receipt.json'
observed=root/'observed.json'
print(json.dumps({'status':result.returncode,'started':json.loads(observed.read_text()) if observed.exists() else None,'finished':json.loads(receipt.read_text()) if receipt.is_file() else None,'open':json.loads((root/'open-receipt.json').read_text()) if (root/'open-receipt.json').is_file() else None,'close':json.loads((root/'close-receipt.json').read_text()) if (root/'close-receipt.json').is_file() else None,'leftovers':len(list(root.glob('.wrapper-receipt-*'))),'verify_required':(root/'verify-required').exists()}))`,
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
