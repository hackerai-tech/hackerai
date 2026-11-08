// Only this static bootstrap is passed as a command argument. The program and
// request (including any CAPTCHA response) travel over protected command stdin.
const CONNECTED_BROWSER_BOOTSTRAP = String.raw`let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{s+=c;if(Buffer.byteLength(s)>131072)process.exit(1)});process.stdin.on('end',()=>{try{const p=JSON.parse(s);new Function('request',p.program)(p.request)}catch{process.exitCode=1}});`;

export const CONNECTED_BROWSER_PROGRAM = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn, spawnSync} = require('node:child_process');
(async () => {
  let root;
  let cleanupAllowed = false;
  try {
    if (!/^[a-f0-9]{24}$/.test(request.owner)) throw Error();
    const base = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
    root = path.join(base, 'hackerai-captcha-' + request.owner);
    const name = 'captcha-' + request.owner;
    const validateRoot = () => {
      const info = fs.lstatSync(root);
      if (!info.isDirectory() || info.isSymbolicLink() ||
        (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw Error();
    };
    const validDeadline = Number.isFinite(request.expiresAt) &&
      request.expiresAt > Date.now() && request.expiresAt <= Date.now() + 86400000;
    if (request.action === 'prepare') {
      if (!validDeadline || typeof request.watchdogProgram !== 'string' ||
          request.watchdogProgram.length > 20000 || typeof request.bootstrap !== 'string' ||
          request.bootstrap.length > 1000) throw Error();
      // Refuse inherited attachment/profile settings rather than opening a
      // user's browser or restoring saved authentication.
      if (['AGENT_BROWSER_PROFILE', 'AGENT_BROWSER_STATE', 'AGENT_BROWSER_SESSION_NAME',
           'AGENT_BROWSER_CDP', 'AGENT_BROWSER_AUTO_CONNECT', 'AGENT_BROWSER_PROVIDER']
          .some(key => process.env[key])) throw Error();
      fs.mkdirSync(root, {mode: 0o700});
      cleanupAllowed = true;
      fs.mkdirSync(path.join(root, 'sockets'), {mode: 0o700});
      fs.mkdirSync(path.join(root, 'state'), {mode: 0o700});
      fs.writeFileSync(path.join(root, 'config.json'), '{}', {mode: 0o600});
      if (request.initScript !== undefined) {
        if (typeof request.initScript !== 'string' || request.initScript.length > 16384) throw Error();
        const version = spawnSync('agent-browser', ['--version'], {
          shell: process.platform === 'win32', windowsHide:true, timeout:5000,
          encoding:'utf8', stdio:['ignore','pipe','ignore'], maxBuffer:4096,
        });
        const match = version.status === 0 && /agent-browser (\d+)\.(\d+)\.(\d+)/.exec(version.stdout);
        if (match && (Number(match[1]) > 0 || Number(match[2]) > 39 ||
            (Number(match[2]) === 39 && Number(match[3]) >= 3))) {
          const initPath = path.join(root, 'cloudflare.js');
          fs.writeFileSync(initPath, request.initScript, {mode:0o600});
          fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({initScripts:[initPath]}), {mode:0o600});
        }
      }
      const watchdog = spawn(process.execPath, ['-e', request.bootstrap], {
        detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
      });
      await new Promise((resolve, reject) => {
        watchdog.once('error', reject);
        watchdog.once('spawn', resolve);
      });
      watchdog.stdin.on('error', () => {});
      watchdog.stdin.end(JSON.stringify({program:request.watchdogProgram,
        request:{action:'cleanup', owner:request.owner, expiresAt:request.expiresAt, defer:true}}));
      watchdog.unref();
      cleanupAllowed = false;
      console.log(JSON.stringify({root, name}));
      return;
    }
    if (!['evaluate', 'cloudflare', 'cleanup'].includes(request.action)) throw Error();
    if (request.action === 'cleanup' && request.defer === true) {
      // A bad deadline must never authorize deleting a still-live namespace.
      if (!Number.isFinite(request.expiresAt) || request.expiresAt > Date.now() + 86400000) throw Error();
      while (fs.existsSync(root) && Date.now() < request.expiresAt)
        await new Promise(resolve => setTimeout(resolve, 1000));
      if (!fs.existsSync(root)) return;
    }
    validateRoot();
    if (request.action !== 'cleanup' && (!validDeadline ||
        typeof request.script !== 'string' || request.script.length > 65536)) throw Error();
    const command = request.action === 'cleanup'
      ? {id:'captcha-cleanup', action:'close'}
      : {id:'captcha-evaluate', action:'evaluate', script:request.script};
    const suffix = process.platform === 'win32' ? '.port' : '.sock';
    const directory = path.join(root, 'sockets');
    const entries = fs.readdirSync(directory).filter(file => file.endsWith(suffix));
    // Explicit --session names are legitimate, but inspecting an arbitrary one
    // of several browsers could deliver a response into the wrong document.
    if (entries.length > 32 || (request.action !== 'cleanup' && entries.length !== 1)) throw Error();
    if (request.action !== 'cleanup' && request.sessionName !== undefined &&
        (typeof request.sessionName !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(request.sessionName) ||
         entries[0] !== request.sessionName + suffix)) throw Error();
    let stopped = false;
    process.on('SIGTERM', () => { stopped = true; });
    const callDaemon = async (file, command, restoring = false) => {
      if (request.action !== 'cleanup' && !restoring && (stopped || Date.now() >= request.expiresAt)) throw Error();
      const socketFile = path.join(directory, file);
      const attempts = request.action === 'cleanup' && request.defer === true ? 3 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        let socket;
        let timer;
        try {
          let address;
          const entry = fs.lstatSync(socketFile);
          if (entry.isSymbolicLink() || (process.getuid && entry.uid !== process.getuid())) throw Error();
          if (process.platform === 'win32') {
            const port = Number(fs.readFileSync(socketFile, 'utf8').trim());
            if (!entry.isFile() || !Number.isInteger(port) || port < 1 || port > 65535) throw Error();
            address = {host:'127.0.0.1', port};
          } else {
            if (!entry.isSocket()) throw Error();
            address = socketFile;
          }
          const response = await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(Error()), 7500);
            socket = net.createConnection(address);
            socket.setEncoding('utf8');
            let result = '';
            socket.once('connect', () => socket.write(JSON.stringify(command) + '\n'));
            socket.on('error', reject);
            socket.on('end', () => reject(Error()));
            socket.on('data', data => {
              result += data;
              if (Buffer.byteLength(result) > 65536) { reject(Error()); return; }
              const newline = result.indexOf('\n');
              if (newline >= 0) {
                try { resolve(JSON.parse(result.slice(0,newline))); } catch { reject(Error()); }
              }
            });
          });
          if (response.success !== true) throw Error();
          return response.data?.result;
        } catch (error) {
          if (request.action === 'cleanup' && error.code === 'ENOENT') return;
          if (attempt + 1 === attempts) throw error;
        } finally {
          clearTimeout(timer);
          socket?.destroy();
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    };
    if (request.action === 'cloudflare') {
      const validUa = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && /^[\x20-\x7e]+$/.test(value);
      if (!validUa(request.userAgent) || !validUa(request.originalUserAgent) ||
          typeof request.identityScript !== 'string' || request.identityScript.length > 8192) throw Error();
      const file = entries[0];
      const call = (command, restoring = false) => callDaemon(file, command, restoring);
      if (await call({id:'captcha-identity',action:'evaluate',script:request.identityScript}) !== true) {
        console.log(JSON.stringify({ok:true,result:{status:'page_changed'}})); return;
      }
      let delivered = false;
      try {
        await call({id:'captcha-useragent',action:'useragent',userAgent:request.userAgent});
        const result = await call({id:'captcha-deliver',action:'evaluate',script:request.script});
        if (!result || !['page_changed','token_delivered'].includes(result.status)) throw Error();
        delivered = result.status === 'token_delivered';
        console.log(JSON.stringify({ok:true,result:{status:result.status}}));
      } finally {
        if (!delivered) await call({id:'captcha-restore-useragent',action:'useragent',userAgent:request.originalUserAgent}, true).catch(() => {});
      }
      return;
    }
    const results = await Promise.allSettled(entries.map(file => callDaemon(file, command)));
    if (results.some(result => result.status === 'rejected')) throw Error();
    cleanupAllowed = request.action === 'cleanup';
    console.log(JSON.stringify({ok:true,result:request.action === 'evaluate' ? results[0].value : undefined}));
  } catch {
    console.log('{"ok":false}');
    process.exitCode = 1;
  } finally {
    // Preserve a failed-close namespace for the independent watchdog instead
    // of deleting its socket and abandoning a still-running browser.
    if (cleanupAllowed && root) {
      try {
        const info = fs.lstatSync(root);
        if (info.isDirectory() && !info.isSymbolicLink() &&
            (!process.getuid || info.uid === process.getuid())) fs.rmSync(root,{recursive:true});
      } catch {}
    }
  }
})();
`;

export const connectedBrowserCommand = `node -e "${CONNECTED_BROWSER_BOOTSTRAP}"`;
export function connectedBrowserRequest(
  request: Record<string, unknown>,
): string {
  return JSON.stringify({
    program: CONNECTED_BROWSER_PROGRAM,
    request: {
      ...request,
      ...(request.action === "prepare" && {
        watchdogProgram: CONNECTED_BROWSER_PROGRAM,
        bootstrap: CONNECTED_BROWSER_BOOTSTRAP,
      }),
    },
  });
}
