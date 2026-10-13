import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

// Run the installed dependency in a separate process: unhandled rejections must
// be observed at the Node process boundary, independently of Jest's handlers.
const runtimePath = join(
  dirname(require.resolve("resumable-stream")),
  "runtime.js",
);

function runScenario(scenario: string) {
  return execFileSync(
    process.execPath,
    [
      "--unhandled-rejections=strict",
      "-e",
      `
      const assert = require('node:assert/strict');
      const { createResumableStreamContextFactory } = require(${JSON.stringify(runtimePath)});
      const tick = () => new Promise(resolve => setImmediate(resolve));
      const failure = new Error('Connection timeout');
      const make = (subscriber, publisher) => createResumableStreamContextFactory({
        subscriber: () => subscriber,
        publisher: () => publisher,
      })({ waitUntil: () => {} });
      const watchdog = setTimeout(() => {
        console.error('Scenario did not complete');
        process.exit(1);
      }, 2000);
      (async () => { ${scenario} })()
        .catch(error => { console.error(error); process.exitCode = 1; })
        .finally(() => clearTimeout(watchdog));
      `,
    ],
    { encoding: "utf8", timeout: 5000, env: {} },
  );
}

describe("resumable-stream initialization patch", () => {
  it("contains both rejected connections when the context is never consumed", () => {
    runScenario(`
      let connections = 0;
      const client = { connect: () => { connections++; return Promise.reject(failure); } };
      make(client, client);
      await tick();
      assert.equal(connections, 2);
    `);
  });

  it.each([
    "createNewResumableStream",
    "resumeExistingStream",
    "resumableStream",
    "hasExistingStream",
  ])("preserves the original failure for delayed %s callers", (method) => {
    runScenario(`
      const client = { connect: () => Promise.reject(failure), get: () => assert.fail('read before initialization') };
      const context = make(client, client);
      await tick();
      await assert.rejects(context[${JSON.stringify(method)}]('id', () => assert.fail('stream created')), error => error === failure);
      await tick();
    `);
  });

  it("contains synchronous connect failures and partially constructed contexts", () => {
    runScenario(`
      const client = { connect: () => { throw failure; } };
      const context = make(client, client);
      await tick();
      await assert.rejects(context.hasExistingStream('id'), error => error === failure);
      const create = createResumableStreamContextFactory({
        subscriber: () => client,
        publisher: () => { throw new Error('Invalid configuration'); },
      });
      assert.throws(() => create({ waitUntil: () => {} }), /Invalid configuration/);
      await tick();
    `);
  });

  it("waits for both connections before checking stream state", () => {
    runScenario(`
      let release;
      let reads = 0;
      const subscriber = { connect: () => new Promise(resolve => { release = resolve; }) };
      const publisher = { connect: async () => {}, get: async () => { reads++; return 'DONE'; } };
      const context = make(subscriber, publisher);
      const result = context.hasExistingStream('id');
      await tick();
      assert.equal(reads, 0);
      release();
      assert.equal(await result, 'DONE');
      assert.equal(reads, 1);
    `);
  });

  it("streams through completion after healthy initialization without reconnecting", () => {
    runScenario(`
      let connections = 0;
      let finished;
      const writes = [];
      const subscriber = { connect: async () => { connections++; }, subscribe: async () => {}, unsubscribe: async () => {} };
      const publisher = { connect: async () => { connections++; }, set: async (...args) => { writes.push(args); }, publish: async () => {} };
      const context = createResumableStreamContextFactory({ subscriber: () => subscriber, publisher: () => publisher })({ waitUntil: promise => { finished = promise; } });
      const stream = await context.createNewResumableStream('id', () => new ReadableStream({
        start(controller) { controller.enqueue('data: healthy\\n\\n'); controller.close(); }
      }));
      const reader = stream.getReader();
      assert.deepEqual(await reader.read(), { done: false, value: 'data: healthy\\n\\n' });
      assert.equal((await reader.read()).done, true);
      await finished;
      assert.equal(connections, 2);
      assert.equal(writes.at(-1)[1], 'DONE');
    `);
  });
});
