import { execFileSync } from "node:child_process";
import { createTriggerRunReadDiagnostics } from "../trigger-run-read-diagnostics";

afterEach(() => jest.restoreAllMocks());

it("ignores callback arguments and keeps the first bounded timing", () => {
  const clock = jest.spyOn(Date, "now").mockReturnValue(1000);
  const diagnostic = createTriggerRunReadDiagnostics();
  expect(diagnostic.snapshot()).toMatchObject({
    trigger_run_read_api_body: "not_observed",
    trigger_run_read_api_body_elapsed_ms: null,
  });
  const privateBody = new Proxy(
    {},
    {
      get: () => {
        throw new Error("private body read");
      },
    },
  );
  clock.mockReturnValue(3000);
  Reflect.apply(diagnostic.requestOptions.onResponseBody, undefined, [
    privateBody,
    privateBody,
  ]);
  clock.mockReturnValue(100_000);
  diagnostic.requestOptions.onResponseBody();
  expect(diagnostic.snapshot()).toEqual({
    trigger_run_read_diagnostic_version: 1,
    trigger_run_read_api_body: "validated_body_observed",
    trigger_run_read_api_body_elapsed_ms: 2000,
    trigger_run_read_api_body_elapsed_capped: false,
  });
  expect(Object.keys(diagnostic.requestOptions)).toEqual(["onResponseBody"]);
});

it.each(["throw", "invalid", "backward", "cap"])(
  "isolates the %s clock case",
  (mode) => {
    const clock = jest.spyOn(Date, "now").mockReturnValue(1000);
    const diagnostic = createTriggerRunReadDiagnostics();
    if (mode === "throw")
      clock.mockImplementation(() => {
        throw new Error("clock unavailable");
      });
    else
      clock.mockReturnValue(
        mode === "invalid" ? NaN : mode === "backward" ? 500 : 100_000,
      );
    expect(() => diagnostic.requestOptions.onResponseBody()).not.toThrow();
    expect(diagnostic.snapshot()).toMatchObject({
      trigger_run_read_api_body: "validated_body_observed",
      trigger_run_read_api_body_elapsed_ms:
        mode === "throw" || mode === "invalid"
          ? null
          : mode === "backward"
            ? 0
            : 60_000,
      trigger_run_read_api_body_elapsed_capped: mode === "cap",
    });
  },
);

it("keeps concurrent read observations independent", () => {
  const first = createTriggerRunReadDiagnostics();
  const second = createTriggerRunReadDiagnostics();
  first.requestOptions.onResponseBody();
  expect(first.snapshot().trigger_run_read_api_body).toBe(
    "validated_body_observed",
  );
  expect(second.snapshot().trigger_run_read_api_body).toBe("not_observed");
});

it("uses the installed SDK callback before packet resolution without changing requests, payloads or API errors", () => {
  // A child keeps the real SDK and global fetch isolated from Jest/other tests.
  const script = String.raw`
    const fs=require('node:fs'),Module=require('node:module'),ts=require('typescript'),assert=require('node:assert/strict');
    const filename=require('node:path').resolve('lib/api/trigger-run-read-diagnostics.ts');
    const helper=new Module(filename,module);helper.filename=filename;helper.paths=module.paths;
    helper._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,filename);
    const {createTriggerRunReadDiagnostics}=helper.exports;
    const {configure,runs}=require('@trigger.dev/sdk');
    configure({baseURL:'https://trigger.fixture.invalid',accessToken:'fixture-not-a-credential'});
    const fixture={id:'run_fixture',status:'EXECUTING',taskIdentifier:'agent-long',isQueued:false,isExecuting:true,isWaiting:false,isCompleted:false,isSuccess:false,isFailed:false,isCancelled:false,isTest:true,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',tags:[],costInCents:0,baseCostInCents:0,durationMs:0,depth:0,triggerFunction:'trigger',relatedRuns:{},metadata:{private:'not-to-log'}};
    let stage='setup';
    (async()=>{
      let releaseAPI,releasePacket,bodySeen;
      const apiGate=new Promise(r=>releaseAPI=r),packetGate=new Promise(r=>releasePacket=r),bodyGate=new Promise(r=>bodySeen=r);
      const urls=[];global.fetch=async(input)=>{const url=String(input);urls.push(url);assert(url.startsWith('https://trigger.fixture.invalid/')||url==='https://packet.fixture.invalid/private');return url.startsWith('https://trigger.fixture.invalid/')?apiGate:packetGate;};
      const d=createTriggerRunReadDiagnostics();
      const pending=runs.retrieve('run_fixture',{...d.requestOptions,onResponseBody:()=>{d.requestOptions.onResponseBody();bodySeen();}});
      const completed=pending.then(x=>x);
      assert.equal(d.snapshot().trigger_run_read_api_body,'not_observed');
      releaseAPI(Response.json({...fixture,payloadPresignedUrl:'https://packet.fixture.invalid/private'}));
      stage='validated-body-boundary';await bodyGate;
      assert.equal(d.snapshot().trigger_run_read_api_body,'validated_body_observed');
      assert(!JSON.stringify(d.snapshot()).includes('private'));
      releasePacket(Response.json({private:'fixture-payload'}));
      stage='packet-result';const run=await completed;assert.deepEqual(run.payload,{private:'fixture-payload'});assert.equal(urls.length,2);
      let calls=0;global.fetch=async()=>{calls++;return Response.json({error:'fixture denied'},{status:403});};
      const rejected=createTriggerRunReadDiagnostics();
      stage='HTTP403';await assert.rejects(runs.retrieve('run_denied',rejected.requestOptions),e=>e.status===403);
      assert.equal(calls,1);assert.equal(rejected.snapshot().trigger_run_read_api_body,'not_observed');
      calls=0;global.fetch=async()=>{calls++;return Response.json({invalid:'schema'});};
      const invalid=createTriggerRunReadDiagnostics();
      stage='schema-rejection';await assert.rejects(runs.retrieve('run_invalid',invalid.requestOptions),e=>e.constructor.name==='ApiSchemaValidationError');
      assert.equal(calls,1);assert.equal(invalid.snapshot().trigger_run_read_api_body,'not_observed');
      console.log('SDK contract PASS: API wait, packet wait, preserved payload,403 and schema rejection');
    })().catch(e=>{console.error('SDK callback contract failed:'+stage+':'+e.constructor.name);process.exitCode=1;});
  `;
  const output = execFileSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    timeout: 10_000,
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
  expect(output).toContain("SDK contract PASS");
});
