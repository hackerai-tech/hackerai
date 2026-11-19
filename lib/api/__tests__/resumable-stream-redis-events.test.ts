import { execFileSync } from "node:child_process";

const redisEntryPath = require.resolve("resumable-stream/redis");

function runRedisScenario(scenario: string) {
  return execFileSync(
    process.execPath,
    [
      "--unhandled-rejections=strict",
      "-e",
      `
      const assert = require('node:assert/strict');
      const { EventEmitter } = require('node:events');
      const Module = require('node:module');
      const originalLoad = Module._load;
      const clients = [];
      const warnings = [];
      console.warn = value => warnings.push(value);
      Module._load = function(id, ...args) {
        if (id === 'redis') return { createClient: () => {
          const client = Object.assign(new EventEmitter(), {
            connect: async () => {},
            get: async () => 'ACTIVE',
          });
          clients.push(client);
          return client;
        }};
        return originalLoad.call(this, id, ...args);
      };
      const { createResumableStreamContext } = require(${JSON.stringify(redisEntryPath)});
      const tick = () => new Promise(resolve => setImmediate(resolve));
      const failure = Object.assign(new Error('private Redis host and credentials'), { code: 'ECONNRESET' });
      const watchdog = setTimeout(() => { console.error('Scenario did not complete'); process.exit(1); }, 2000);
      (async () => { ${scenario} })()
        .catch(error => { console.error(error); process.exitCode = 1; })
        .finally(() => clearTimeout(watchdog));
      `,
    ],
    {
      encoding: "utf8",
      timeout: 5000,
      env: { REDIS_URL: "redis://localhost:6379" },
    },
  );
}

describe("resumable-stream owned Redis client errors", () => {
  it("survives both clients' socket errors while preserving command failures", () => {
    runRedisScenario(`
      const context = createResumableStreamContext({ waitUntil: () => {} });
      assert.equal(await context.hasExistingStream('stream'), true);
      assert.equal(clients.length, 2);
      for (const client of clients) {
        client.emit('error', failure);
        client.emit('error', new Error('another private target'));
      }
      await tick();
      assert.equal(await context.hasExistingStream('stream'), true);
      assert.equal(warnings.length, 2);
      const diagnostics = warnings.map(value => JSON.parse(value));
      assert.deepEqual(diagnostics.map(value => value.client).sort(), ['publisher', 'subscriber']);
      assert.ok(diagnostics.every(value => value.event === 'resumable_stream_redis_error' && value.reason === 'ECONNRESET'));
      assert.ok(!JSON.stringify(warnings).includes('private'));
      clients.forEach(client => { client.get = async () => { throw failure; }; });
      await assert.rejects(context.hasExistingStream('stream'), error => error === failure);
    `);
  });

  it("preserves initialization rejection when the socket emits an error first", () => {
    runRedisScenario(`
      const context = createResumableStreamContext({ waitUntil: () => {} });
      clients.forEach(client => {
        client.connect = async () => {
          client.emit('error', Object.assign(new Error('private startup target'), { code: 'PRIVATE_VALUE' }));
          throw failure;
        };
      });
      await tick();
      await assert.rejects(context.hasExistingStream('stream'), error => error === failure);
      assert.equal(warnings.length, 2);
      assert.ok(warnings.every(value => JSON.parse(value).reason === 'unknown'));
      assert.ok(!JSON.stringify(warnings).includes('PRIVATE_VALUE'));
      assert.ok(!JSON.stringify(warnings).includes('private'));
    `);
  });
});
