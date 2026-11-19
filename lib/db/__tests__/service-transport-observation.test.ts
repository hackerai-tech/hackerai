import { channel } from "node:diagnostics_channel";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerServiceTransportObserver } from "../service-transport-observation.node";
import { observeServiceTransport } from "../service-transport-observation";

const url = new URL("https://fixture.convex.cloud/api/query");
const request = () => ({
  origin: url.origin,
  path: url.pathname,
  method: "POST",
});
const publish = (name: string, message: object) =>
  channel(`undici:${name}`).publish(message);

beforeAll(() => registerServiceTransportObserver());

it("correlates interleaved requests by identity after their ALS contexts exit", async () => {
  const first = observeServiceTransport(url);
  const second = observeServiceTransport(url);
  const a = request();
  const b = request();
  await Promise.all([
    first.run(async () => {
      await Promise.resolve();
      publish("request:create", { request: a });
    }),
    second.run(async () => {
      await Promise.resolve();
      publish("request:create", { request: b });
    }),
  ]);
  publish("client:sendHeaders", { request: b, socket: {} });
  publish("request:bodySent", { request: b });
  publish("request:headers", { request: a });
  expect(first.snapshot()).toMatchObject({
    transport_observation: "response_headers_received",
    transport_request_count: 1,
  });
  expect(second.snapshot()).toMatchObject({
    transport_observation: "request_body_sent",
    transport_request_count: 1,
    socket_prior_service_use_observed: false,
  });
  first.finish();
  second.finish();
});

it("records previous service socket use without calling first observation fresh or elapsed time idle", () => {
  const socket = {};
  publish("client:connected", { socket });
  const first = observeServiceTransport(url);
  const a = request();
  first.run(() => publish("request:create", { request: a }));
  publish("client:sendHeaders", { request: a, socket });
  first.finish();
  const next = observeServiceTransport(url);
  const b = request();
  next.run(() => publish("request:create", { request: b }));
  publish("client:sendHeaders", { request: b, socket });
  expect(next.snapshot()).toMatchObject({
    socket_prior_service_use_observed: true,
    socket_previous_dispatch_age_ms: expect.any(Number),
    socket_connection_age_ms: expect.any(Number),
  });
  next.finish();
});

it("ignores foreign traffic, pool errors, malformed messages and events after completion", () => {
  const observation = observeServiceTransport(url);
  observation.run(() => {
    publish("request:create", {
      request: { ...request(), path: "/api/action" },
    });
    publish("request:create", {
      request: { ...request(), origin: "https://private.example" },
    });
    publish("request:create", { request: { ...request(), method: "GET" } });
    publish("client:connectError", { error: new Error("PRIVATE_ERROR") });
    expect(() => publish("request:create", {})).not.toThrow();
  });
  expect(observation.snapshot()).toMatchObject({
    transport_observation: "no_request_event",
  });
  const a = request();
  observation.run(() => publish("request:create", { request: a }));
  observation.finish();
  publish("request:headers", { request: a });
  expect(observation.snapshot().transport_observation).toBe("request_created");
});

it("registers once and clears the previous dispatch evidence for another request in a fetch", () => {
  registerServiceTransportObserver();
  const observation = observeServiceTransport(url);
  const a = request();
  const b = request();
  observation.run(() => {
    publish("request:create", { request: a });
    publish("client:sendHeaders", { request: a, socket: {} });
    publish("request:create", { request: b });
  });
  expect(observation.snapshot()).toEqual({
    node_version: process.versions.node,
    ...(process.versions.undici
      ? { node_bundled_undici_version: process.versions.undici }
      : {}),
    transport_observation: "request_created",
    transport_request_count: 2,
  });
  publish("request:headers", { request: a });
  expect(observation.snapshot().transport_observation).toBe("request_created");
  observation.finish();
});

it("matches one exact GET target per observation without crossing concurrent GET or POST calls", async () => {
  const runA = new URL("https://trigger.fixture.test/api/v3/runs/run_a");
  const runB = new URL("https://trigger.fixture.test/api/v3/runs/run_b");
  const dispatch = (target: URL, method: string) => ({
    origin: target.origin,
    path: target.pathname,
    method,
  });
  const getA = observeServiceTransport(runA, { method: "GET" });
  const getB = observeServiceTransport(runB, { method: "GET" });
  const post = observeServiceTransport(url);
  const a1 = dispatch(runA, "GET");
  const b = dispatch(runB, "GET");
  const p = request();
  await Promise.all([
    getA.run(async () => {
      await Promise.resolve();
      publish("request:create", { request: dispatch(runA, "POST") });
      publish("request:create", { request: dispatch(runB, "GET") });
      publish("request:create", {
        request: { ...dispatch(runA, "GET"), origin: "https://other.test" },
      });
      publish("request:create", { request: a1 });
    }),
    getB.run(async () => {
      await Promise.resolve();
      publish("request:create", { request: b });
    }),
    post.run(async () => {
      await Promise.resolve();
      publish("request:create", { request: dispatch(url, "GET") });
      publish("request:create", { request: p });
    }),
  ]);
  publish("client:sendHeaders", { request: b, socket: {} });
  publish("request:headers", { request: a1 });
  publish("request:headers", { request: p });
  expect(getA.snapshot()).toMatchObject({
    transport_observation: "response_headers_received",
    transport_request_count: 1,
  });
  expect(getB.snapshot()).toMatchObject({
    transport_observation: "socket_assigned",
    transport_request_count: 1,
  });
  expect(post.snapshot()).toMatchObject({
    transport_observation: "response_headers_received",
    transport_request_count: 1,
  });

  // A newer attempt resets the phase; the earlier attempt's late events and
  // anything after finish cannot make it look further along.
  const a2 = dispatch(runA, "GET");
  getA.run(() => publish("request:create", { request: a2 }));
  publish("request:headers", { request: a1 });
  publish("client:sendHeaders", { request: a1, socket: {} });
  expect(getA.snapshot()).toMatchObject({
    transport_observation: "request_created",
    transport_request_count: 2,
  });
  expect(getA.snapshot()).not.toHaveProperty(
    "socket_prior_service_use_observed",
  );
  publish("request:bodySent", { request: a2 });
  getA.finish();
  publish("request:headers", { request: a2 });
  getA.run(() => publish("request:create", { request: dispatch(runA, "GET") }));
  expect(getA.snapshot()).toMatchObject({
    transport_observation: "request_body_sent",
    transport_request_count: 2,
  });

  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error("PRIVATE_REQUEST");
      },
    },
  );
  getB.run(() => {
    for (const message of [
      {},
      { request: null },
      { request: "PRIVATE" },
      { request: hostile },
    ])
      expect(() => publish("request:create", message)).not.toThrow();
  });
  for (const message of [{ request: hostile, socket: {} }, { request: 1 }])
    expect(() => publish("client:sendHeaders", message)).not.toThrow();
  expect(getB.snapshot()).toMatchObject({
    transport_observation: "socket_assigned",
    transport_request_count: 1,
  });
  getB.finish();
  post.finish();
});

it("keeps any method other than an exact GET opt-in on the existing POST contract", () => {
  const observation = observeServiceTransport(url, {
    method: "DELETE" as never,
  });
  observation.run(() => {
    publish("request:create", { request: { ...request(), method: "DELETE" } });
    publish("request:create", { request: { ...request(), method: "GET" } });
  });
  expect(observation.snapshot().transport_observation).toBe("no_request_event");
  observation.run(() => publish("request:create", { request: request() }));
  expect(observation.snapshot()).toMatchObject({
    transport_observation: "request_created",
    transport_request_count: 1,
  });
  observation.finish();
});

it("observes real Node fetch on a reused socket reset and correlates an HTTP 520 without logging successes", async () => {
  // Run outside jsdom to exercise Node's actual built-in fetch and channels.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
    import { createServer } from 'node:http';
    import { once } from 'node:events';
    import { Agent } from 'undici';
    import { createServiceFetch } from './lib/db/service-client.ts';
    import { registerServiceTransportObserver } from './lib/db/service-transport-observation.node.ts';
    registerServiceTransportObserver();
    const logs = [];
    console.warn = line => logs.push(JSON.parse(line));
    let calls = 0;
    const server = createServer(async (req, res) => {
      for await (const chunk of req) {}
      calls++;
      if (calls === 2) { req.socket.destroy(); return; }
      if (calls === 3) {
        res.writeHead(520, { 'cf-ray': '9abc1234def56789-IAD', 'set-cookie': 'PRIVATE_COOKIE' });
        res.end('PRIVATE_BODY'); return;
      }
      res.end('{"status":"success","value":"ok"}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    const agent = new Agent({ connections: 1 });
    const wrapped = createServiceFetch(origin, (input, init) => fetch(input, { ...init, dispatcher: agent }));
    const options = { method: 'POST', body: JSON.stringify({ path: 'fixture:accept', format: 'convex_encoded_json', args: [{ target: 'PRIVATE_TARGET' }] }) };
    try {
      const ok = await wrapped(origin + '/api/query', options);
      const success = await ok.text();
      const successLogs = logs.length;
      let rejected = false;
      try { await wrapped(origin + '/api/query', options); } catch { rejected = true; }
      const failed = await wrapped(origin + '/api/query', options);
      console.log(JSON.stringify({ success, successLogs, rejected, status: failed.status, calls, logs }));
    } finally {
      await agent.close(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `,
    ],
    { cwd: process.cwd(), timeout: 15000 },
  );
  const result = JSON.parse(stdout.trim());
  expect(result).toMatchObject({
    successLogs: 0,
    rejected: true,
    status: 520,
    calls: 3,
  });
  expect(JSON.parse(result.success).value).toBe("ok");
  expect(result.logs).toHaveLength(2);
  expect(result.logs[0]).toMatchObject({
    reason: "transport_error",
    transport_observation: "request_body_sent",
    socket_prior_service_use_observed: true,
    transport_request_count: 1,
    socket_connection_age_ms: expect.any(Number),
    node_version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    node_bundled_undici_version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
  });
  expect(result.logs[1]).toMatchObject({
    reason: "http_5xx",
    cf_ray: "9abc1234def56789-IAD",
    transport_observation: "response_headers_received",
  });
  expect(JSON.stringify(result.logs)).not.toMatch(/PRIVATE|127\.0\.0\.1/);
}, 20000);
