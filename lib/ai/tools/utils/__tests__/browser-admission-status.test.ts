import { execFileSync } from "node:child_process";
import { BROWSER_SESSION_PROGRAM } from "../browser-session-program";

it.each([
  [null, "unset"],
  ["0", "disabled"],
  [" 900000 ", "15m"],
  ["899999", "lt_15m"],
  ["900001", "gt_15m"],
  ["PRIVATE_VALUE", "unparsed"],
  ["18446744073709551616", "unparsed"],
  ["0".repeat(129), "unparsed"],
  ["900000", "15m", 65400], // Including the printed newline: exactly 65,536.
  ["900000", undefined, 65401], // Metadata would exceed the cap by one byte.
] as Array<[string | null, string | undefined, number?]>)(
  "observes ambient idle setting %j without changing daemon status",
  (idle, expected, padding = 0) => {
    const result = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          `import contextlib,io,json,os,pathlib,socket,stat,subprocess,sys,types
from unittest.mock import patch
x=json.load(sys.stdin)
if x['idle'] is None: os.environ.pop('AGENT_BROWSER_IDLE_TIMEOUT_MS',None)
else: os.environ['AGENT_BROWSER_IDLE_TIMEOUT_MS']=x['idle']
os.environ['UNRELATED_PRIVATE_ENV']='PRIVATE_SECRET'
requests=[]
response={'id':'handoff-status','success':True,'data':{'connected':True,'port':9223}}
if x['padding']: response['padding']='x'*x['padding']
class Connection:
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def settimeout(self,value): pass
    def connect(self,address): pass
    def sendall(self,data): requests.append(json.loads(data))
    def makefile(self,*args): return io.BytesIO(json.dumps(response).encode()+b'\\n')
def info(p): return types.SimpleNamespace(st_mode=stat.S_IFSOCK if str(p).endswith('.sock') else stat.S_IFDIR,st_uid=os.getuid())
sys.argv=['status-program','status','/dev/shm/hackerai-browser-fixture']
out=io.StringIO()
with patch.object(pathlib.Path,'lstat',info),patch.object(pathlib.Path,'read_text',return_value='default'),patch.object(socket,'socket',return_value=Connection()),patch.object(subprocess,'run',side_effect=AssertionError('CLI must not run')),contextlib.redirect_stdout(out):
    exec(compile(x['program'],'status-program','exec'))
print(json.dumps({'response':json.loads(out.getvalue()),'requests':requests,'stdout_length':len(out.getvalue())}))`,
        ],
        {
          input: JSON.stringify({
            idle,
            padding,
            program: BROWSER_SESSION_PROGRAM,
          }),
          encoding: "utf8",
        },
      ),
    );
    expect(result.response).toEqual({
      id: "handoff-status",
      success: true,
      data: { connected: true, port: 9223 },
      ...(padding ? { padding: expect.any(String) } : {}),
      ...(expected === undefined
        ? {}
        : { hackerai_env_idle_timeout: expected }),
    });
    if (padding) expect(result.response.padding).toHaveLength(padding);
    expect(result.stdout_length).toBeLessThanOrEqual(65_536);
    expect(result.requests).toEqual([
      { id: "handoff-status", action: "stream_status" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_|AGENT_BROWSER_|\/dev\/shm/,
    );
  },
);
