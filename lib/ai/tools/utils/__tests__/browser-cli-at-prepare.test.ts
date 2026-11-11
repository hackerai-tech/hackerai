import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER_SESSION_PROGRAM } from "../browser-session-program";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "hackerai-cli-prepare-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

/** Run the actual prepare branch and filesystem writes, replacing only CLI/watchdog boundaries. */
function prepare(
  stdout: string,
  init = "// controlled adapter",
  fail = false,
  writeFault = false,
  symlink = false,
) {
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        String.raw`
import ast,contextlib,fcntl,io,json,os,pathlib,shutil,socket,stat,subprocess,sys,time,types
x=json.load(sys.stdin)
root=pathlib.Path(x['directory'])/'hackerai-browser-owned'
shim_root=pathlib.Path(x['directory'])/'owned-shim'
directory=str(root)
action='prepare'
sys.argv=['program','prepare',directory,str(time.time()+60),'NO_WATCHDOG','gate',x['init']]
calls=[]
def run(command,**kwargs):
    optional=command==['agent-browser','--version']
    calls.append('optional' if optional else 'bootstrap')
    if optional and x['fail']: raise subprocess.CalledProcessError(37,command,stderr='PRIVATE')
    return types.SimpleNamespace(stdout=x['stdout'],returncode=0)
subprocess.run=run
subprocess.Popen=lambda *a,**k: None
shutil.which=lambda name: '/usr/bin/true'
replace=os.replace
def bounded_replace(source,target):
    if x['writeFault'] and pathlib.Path(target).name=='cli-at-prepare.json': raise PermissionError('PRIVATE')
    if x['symlink'] and pathlib.Path(target).name=='cli-at-prepare.json':
        victim=pathlib.Path(x['directory'])/'owned-victim'
        victim.write_text('PRIVATE_CANARY')
        pathlib.Path(target).symlink_to(victim)
    return replace(source,target)
os.replace=bounded_replace
tree=ast.parse(x['program'])
functions=[n for n in tree.body if isinstance(n,ast.FunctionDef)]
branch=next(n for n in tree.body if isinstance(n,ast.If) and isinstance(n.test,ast.Compare) and isinstance(n.test.left,ast.Name) and n.test.left.id=='action')
with contextlib.redirect_stdout(io.StringIO()):
    exec(compile(ast.fix_missing_locations(ast.Module(body=functions+[branch],type_ignores=[])),'actual-prepare','exec'))
receipt=root/'cli-at-prepare.json'
config=json.loads((root/'config.json').read_text())
result={'cv':json.loads(receipt.read_text()) if receipt.is_file() else None,'mode':stat.S_IMODE(receipt.stat().st_mode) if receipt.is_file() else None,'calls':calls,'init_configured':bool(config.get('initScripts')),'leftovers':len(list(root.glob('.cli-at-prepare-*')))}
if x['symlink']: result['victim_preserved']=(pathlib.Path(x['directory'])/'owned-victim').read_text()=='PRIVATE_CANARY'
print(json.dumps(result))
`,
      ],
      {
        input: JSON.stringify({
          directory,
          stdout,
          init,
          fail,
          writeFault,
          symlink,
          program: BROWSER_SESSION_PROGRAM,
        }),
        encoding: "utf8",
      },
    ),
  );
}

it.each([
  ["agent-browser 0.39.3\n", [1, 1, 39003], true],
  ["agent-browser 0.38.2\n", [1, 1, 38002], false],
  ["agent-browser 999.999.999\n", [1, 1, 999999999], true],
  ["agent-browser 0.39.3\nPRIVATE", [1, 3], true],
  ["agent-browser 1000.39.3\n", [1, 3], true],
  ["agent-browser 0.39.3-rc1\n", [1, 3], true],
  ["PRIVATE".repeat(30), [1, 3], false],
  ["agent-browser 0.39.3 " + "PRIVATE".repeat(30), [1, 3], true],
])(
  "records only strict bounded version context while retaining the feature decision (%#)",
  (stdout, cv, configured) => {
    const result = prepare(stdout as string);
    expect(result).toEqual({
      cv,
      mode: 0o600,
      calls: ["optional", "bootstrap"],
      init_configured: configured,
      leftovers: 0,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  },
);

it("marks the optional check as unmeasured and keeps the single existing bootstrap command", () => {
  expect(prepare("PRIVATE", "")).toEqual({
    cv: [1, 2],
    mode: 0o600,
    calls: ["bootstrap"],
    init_configured: false,
    leftovers: 0,
  });
});

it("retains ordinary preparation when the existing optional version command fails", () => {
  expect(prepare("PRIVATE", "// adapter", true)).toEqual({
    cv: [1, 4],
    mode: 0o600,
    calls: ["optional", "bootstrap"],
    init_configured: false,
    leftovers: 0,
  });
});

it("isolates receipt write failure and cleans only its temporary receipt", () => {
  expect(prepare("agent-browser 0.39.3\n", "// adapter", false, true)).toEqual({
    cv: null,
    mode: null,
    calls: ["optional", "bootstrap"],
    init_configured: true,
    leftovers: 0,
  });
});

it("atomically replaces an owned receipt symlink without writing its target", () => {
  expect(
    prepare("agent-browser 0.39.3\n", "// adapter", false, false, true),
  ).toEqual({
    cv: [1, 1, 39003],
    mode: 0o600,
    calls: ["optional", "bootstrap"],
    init_configured: true,
    leftovers: 0,
    victim_preserved: true,
  });
});
