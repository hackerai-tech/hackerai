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
function prepare(writeFault = false, symlink = false) {
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
sys.argv=['program','prepare',directory,str(time.time()+60),'NO_WATCHDOG','gate']
calls=[]
def run(command,**kwargs):
    calls.append('bootstrap')
    return types.SimpleNamespace(stdout='',returncode=0)
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
          writeFault,
          symlink,
          program: BROWSER_SESSION_PROGRAM,
        }),
        encoding: "utf8",
      },
    ),
  );
}

it("marks the optional check as unmeasured and keeps the single existing bootstrap command", () => {
  expect(prepare()).toEqual({
    cv: [1, 2],
    mode: 0o600,
    calls: ["bootstrap"],
    init_configured: false,
    leftovers: 0,
  });
});

it("isolates receipt write failure and cleans only its temporary receipt", () => {
  expect(prepare(true)).toEqual({
    cv: null,
    mode: null,
    calls: ["bootstrap"],
    init_configured: false,
    leftovers: 0,
  });
});

it("atomically replaces an owned receipt symlink without writing its target", () => {
  expect(prepare(false, true)).toEqual({
    cv: [1, 2],
    mode: 0o600,
    calls: ["bootstrap"],
    init_configured: false,
    leftovers: 0,
    victim_preserved: true,
  });
});
