import { execFileSync } from "node:child_process";
import { BROWSER_SESSION_PROGRAM } from "../browser-session-program";

it.each([
  "ready",
  "expired",
  "paused",
  "scope-change",
  "cancel",
  "drift",
  "oversized",
  "bad-png",
  "scale-mismatch",
])(
  "publishes only a complete same-scope coordinate-qualified image: %s",
  (variant) => {
    const result = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          String.raw`
import contextlib,io,json,os,pathlib,socket,stat,struct,sys,tempfile,time,types,uuid
from unittest.mock import patch
x=json.load(sys.stdin);case=x['case'];root=pathlib.Path('/dev/shm/hackerai-browser-fixture')
outpath=pathlib.Path('/tmp/hac215-test-'+uuid.uuid4().hex+'.png')
actions=[];temporary=[];resized=False;shot=False
original_open=os.open;original_lstat=pathlib.Path.lstat;original_exists=pathlib.Path.exists;original_read=pathlib.Path.read_text

def opened(p,flags,*args):
    return original_open(os.devnull,os.O_RDONLY) if str(p).endswith('/gate.lock') else original_open(p,flags,*args)
def info(p):
    if str(p).startswith(str(root)):return types.SimpleNamespace(st_mode=(stat.S_IFSOCK if str(p).endswith('.sock') else stat.S_IFDIR)|0o700,st_uid=os.getuid())
    return original_lstat(p)
def exists(p):
    if p==root/'paused':return case=='paused'
    if p==root/'verify-required':return False
    return original_exists(p)
def text(p,*args,**kwargs):return 'owned' if p==root/'active-session' else original_read(p,*args,**kwargs)
def geometry():
    if case=='scope-change' and resized:return {'status':'page_changed'}
    height=2000 if case=='oversized' else 900
    return {'status':'measured','fullyVisible':resized,'needsViewport':not resized,'viewport':{'width':1280,'height':1024 if resized else 600},'frame':{'x':101 if case=='drift' and shot else 100,'y':62 if resized else -150,'width':400,'height':height},'devicePixelRatio':2 if case=='scale-mismatch' else 1}
class Connection:
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def settimeout(self,value):pass
    def connect(self,p):pass
    def sendall(self,b):
        global resized,shot
        c=json.loads(b);actions.append(c['action'])
        if c['action']=='viewport':
            resized=True
            if case=='cancel':raise InterruptedError()
            self.data={}
        elif c['action']=='screenshot':
            shot=True;p=pathlib.Path(c['path']);temporary.append(p)
            p.write_bytes(b'bad' if case=='bad-png' else b'\x89PNG\r\n\x1a\n'+b'\x00\x00\x00\rIHDR'+struct.pack('>II',1280,1024))
            self.data={}
        else:self.data={'result':geometry()}
    def makefile(self,*args):return io.BytesIO(json.dumps({'success':True,'data':self.data}).encode()+b'\n')
request={'path':str(outpath),'deadline':0 if case=='expired' else int(time.time()*1000)+8000,'sessionName':'owned','prepareScript':'public-geometry','measureScript':'public-geometry'}
sys.argv=['capture','vision',str(root),str(time.time()+60)];captured=io.StringIO();failed=False
try:
    with patch.object(os,'open',opened),patch.object(pathlib.Path,'lstat',info),patch.object(pathlib.Path,'exists',exists),patch.object(pathlib.Path,'read_text',text),patch('fcntl.flock',return_value=None),patch.object(socket,'socket',return_value=Connection()),patch.object(sys,'stdin',io.StringIO(json.dumps(request))),contextlib.redirect_stdout(captured):
        try:exec(compile(x['program'],'capture-program','exec'),{})
        except Exception:failed=True
    value={'failed':failed,'published':outpath.exists(),'temporaryCleaned':all(not p.exists() for p in temporary),'actions':actions,'response':json.loads(captured.getvalue()) if captured.getvalue() else None}
    print(json.dumps(value))
finally:
    outpath.unlink(missing_ok=True)
    for p in temporary:p.unlink(missing_ok=True)
`,
        ],
        {
          input: JSON.stringify({
            case: variant,
            program: BROWSER_SESSION_PROGRAM,
          }),
          encoding: "utf8",
        },
      ),
    );
    expect(result.failed).toBe(variant !== "ready");
    expect(result.published).toBe(variant === "ready");
    expect(result.temporaryCleaned).toBe(true);
    if (variant === "ready") {
      expect(result.response).toMatchObject({
        viewport: { width: 1280, height: 1024 },
        image: { width: 1280, height: 1024 },
        devicePixelRatio: 1,
      });
      expect(result.actions).toEqual([
        "evaluate",
        "evaluate",
        "viewport",
        "evaluate",
        "evaluate",
        "screenshot",
        "evaluate",
      ]);
    } else expect(result.response).toBeNull();
    if (["expired", "paused"].includes(variant))
      expect(result.actions).toEqual([]);
    if (["scope-change", "cancel", "oversized"].includes(variant))
      expect(result.actions).not.toContain("screenshot");
  },
);
