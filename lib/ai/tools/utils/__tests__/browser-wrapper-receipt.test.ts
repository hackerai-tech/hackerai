import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER_SESSION_PROGRAM } from "../browser-session-program";

// Execute the actual generated wrapper without provisioning a /dev/shm browser
// or starting the lifecycle watchdog on the shared host.
const exercise = (
  root: string,
  exitCode: number,
  blockedReceipt = false,
  args = ["--session", "PRIVATE_SESSION", "open", "PRIVATE_TARGET"],
  verify = false,
) =>
  JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `import ast,json,pathlib,subprocess,sys
x=json.load(sys.stdin)
root=pathlib.Path(x['root'])
real=root/'fake-browser'
real.write_text('#!/usr/bin/env python3\\nimport json,pathlib,sys\\nr=pathlib.Path('+repr(str(root))+')\\np=r/"wrapper-receipt.json"\\n(r/"observed.json").write_text(p.read_text() if p.is_file() else "null")\\nsys.exit('+str(x['exit'])+')\\n')
real.chmod(0o700)
if x['blocked']: (root/'wrapper-receipt.json').mkdir()
if x['verify']: (root/'verify-required').touch()
tree=ast.parse(x['program'])
assignment=next(n for n in ast.walk(tree) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='wrapper' for t in n.targets))
wrapper=assignment.value.left.value % (str(root),str(real),str(real))
script=root/'wrapper'
script.write_text(wrapper)
result=subprocess.run([sys.executable,str(script),*x['args']],capture_output=True)
receipt=root/'wrapper-receipt.json'
observed=root/'observed.json'
print(json.dumps({'status':result.returncode,'started':json.loads(observed.read_text()) if observed.exists() else None,'finished':json.loads(receipt.read_text()) if receipt.is_file() else None,'leftovers':len(list(root.glob('.wrapper-receipt-*'))),'verify_required':(root/'verify-required').exists()}))`,
      ],
      {
        input: JSON.stringify({
          root,
          exit: exitCode,
          blocked: blockedReceipt,
          args,
          verify,
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
