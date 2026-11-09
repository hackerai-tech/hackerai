import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { verifyTargets } from "./verify-targets.mjs";

const preview = () => ({
  environment: "preview",
  backend: {
    account: "developer",
    project: "hackerai",
    deployment: "preview-test",
    url: "https://preview-test.convex.cloud",
  },
  worker: {
    project: "proj_test",
    environment: "preview",
    branch: "qa",
    version: "20261109.1",
  },
});
const env = {
  CONVEX_ACCESS_TOKEN: "synthetic-convex-secret",
  TRIGGER_ACCESS_TOKEN: "synthetic-trigger-secret",
};
function fixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    request: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      let body;
      if (url.endsWith("team_and_project"))
        body = { team: "developer", project: "hackerai" };
      else if (url.includes("/v1/deployments/"))
        body = {
          name: "preview-test",
          deploymentType: "dev",
          deploymentUrl: "https://preview-test.convex.cloud",
        };
      else if (url.endsWith("/instance_name")) {
        assert.equal(init.headers.authorization, undefined);
        return new Response(overrides.instance ?? "preview-test");
      } else if (url.endsWith("/workers/current"))
        body = { worker: { id: "worker_test", version: "20261109.1" } };
      else body = { externalRef: "proj_test" };
      return Response.json(overrides[url] ?? body);
    },
  };
}
test("verifies provider mapping, actual backend instance and branch-selected worker without exposing credentials", async () => {
  const f = fixture();
  const result = await verifyTargets(preview(), { env, request: f.request });
  assert.equal(result.backend.accountSource, "convex-control-plane");
  assert.equal(result.worker.source, "trigger-control-plane");
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls.at(-1).init.headers["x-trigger-branch"], "qa");
  assert.doesNotMatch(JSON.stringify(result), /synthetic|worker_test/);
});
test("rejects mismatches before contacting later services", async () => {
  const mutations = [
    [
      "https://api.convex.dev/api/deployment/preview-test/team_and_project",
      { team: "wrong", project: "hackerai" },
      /account\/project mismatch/,
      1,
    ],
    [
      "https://api.convex.dev/v1/deployments/preview-test",
      { name: "preview-test", deploymentType: "prod" },
      /designated/,
      2,
    ],
    [
      "https://api.convex.dev/v1/deployments/preview-test",
      {
        name: "preview-test",
        deploymentType: "dev",
        deploymentUrl: "https://other.convex.cloud",
      },
      /URL mismatch/,
      2,
    ],
    ["instance", "other-backend", /deployment mismatch/, 3],
    [
      "https://api.trigger.dev/api/v1/projects/proj_test",
      { externalRef: "proj_other" },
      /project mismatch/,
      4,
    ],
    [
      "https://api.trigger.dev/api/v1/projects/proj_test/preview/workers/current",
      { worker: { id: "test", version: "stale" } },
      /version mismatch/,
      5,
    ],
  ];
  for (const [key, value, pattern, count] of mutations) {
    const f = fixture({ [key]: value });
    await assert.rejects(
      verifyTargets(preview(), { env, request: f.request }),
      pattern,
    );
    assert.equal(f.calls.length, count);
  }
});
test("verifies a live local backend and never forwards a provider credential to it", async (t) => {
  const server = createServer((req, res) => {
    assert.equal(req.url, "/instance_name");
    assert.equal(req.headers.authorization, undefined);
    res.end("local-worktree");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const c = preview();
  c.environment = "local";
  c.backend = {
    account: "local",
    project: "hackerai",
    deployment: "local-worktree",
    url: `http://127.0.0.1:${server.address().port}`,
  };
  c.worker.environment = "development";
  const root = await mkdtemp(join(tmpdir(), "qa-targets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".convex/local/default"), { recursive: true });
  await writeFile(
    join(root, ".convex/local/default/config.json"),
    JSON.stringify({
      deploymentName: c.backend.deployment,
      ports: { cloud: server.address().port },
    }),
  );
  const f = fixture();
  const result = await verifyTargets(c, {
    root,
    env,
    request: (url, init) =>
      url.startsWith(c.backend.url) ? fetch(url, init) : f.request(url, init),
  });
  assert.equal(result.backend.deployment, "local-worktree");
  assert.equal(f.calls.length, 2);
  await writeFile(
    join(root, ".convex/local/default/config.json"),
    JSON.stringify({
      deploymentName: "other-worktree",
      ports: { cloud: server.address().port },
    }),
  );
  await assert.rejects(
    verifyTargets(c, { root, env, request: f.request }),
    /does not match this worktree/,
  );
});
test("fails closed for missing credentials, redirects, unavailable APIs and oversized responses", async () => {
  const f = fixture();
  await assert.rejects(
    verifyTargets(preview(), { env: {}, request: f.request }),
    /required/,
  );
  assert.equal(f.calls.length, 0);
  for (const request of [
    async () => {
      throw new Error("synthetic-secret");
    },
    async () => new Response("synthetic-secret", { status: 302 }),
    async () => new Response("x".repeat(65537)),
  ])
    await assert.rejects(
      verifyTargets(preview(), { env, request }),
      (error) => {
        assert.match(error.message, /unavailable/);
        assert.doesNotMatch(error.message, /synthetic-secret/);
        return true;
      },
    );
});
