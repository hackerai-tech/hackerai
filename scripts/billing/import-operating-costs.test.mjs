import assert from "node:assert/strict";
import { test } from "node:test";
import { importObservation } from "./import-operating-costs.mjs";

const config = {
  target: {
    environment: "production",
    team: "example",
    teamId: 1,
    project: "app",
    projectId: 2,
    deployment: "example-app-123",
    url: "https://example-app-123.convex.cloud",
    reference: "production",
    customDomain: "https://data.example.invalid",
  },
  sources: { workosTeamName: "Example" },
};
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const start = yesterday.slice(0, 7) + "-01";
const periodEnd = new Date(
  Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)), 1),
)
  .toISOString()
  .slice(0, 10);
const observation = {
  vendor: "workos",
  observedAt: new Date().toISOString(),
  startDay: start,
  endDay: yesterday,
  workosTeamName: "Example",
  billingPeriods: [
    {
      start,
      end: periodEnd,
      totalDollars: 31,
      currency: "USD",
      status: "billed",
      reference: "invoice-example",
    },
  ],
};
const identity = {
  team: "example",
  teamId: 1,
  project: "app",
  projectId: 2,
  reference: "production",
};

test("dry run validates and normalizes without reading credentials or accessing a backend", async () => {
  const fail = () => {
    throw Error("unexpected access");
  };
  const result = await importObservation(config, observation, {
    dryRun: true,
    fetcher: fail,
    clientFactory: fail,
    readAccessToken: fail,
  });
  assert.equal(result.dryRun, true);
  assert.ok(result.rowCount >= 1);
});

test("the approved account and custom domain are verified before authorizing and writing once", async () => {
  const calls = [],
    writes = [];
  const result = await importObservation(config, observation, {
    readAccessToken: () => "test-login",
    fetcher: async (url, options) => {
      calls.push({ url, method: options.method ?? "GET" });
      assert.equal(options.redirect, "error");
      if (url.endsWith("team_and_project")) return Response.json(identity);
      if (url.endsWith("instance_name")) {
        assert.equal(options.headers, undefined);
        return new Response("example-app-123");
      }
      assert.equal(
        url,
        "https://api.convex.dev/api/deployment/authorize_within_current_project",
      );
      return Response.json({
        url: config.target.url,
        deploymentName: config.target.deployment,
        reference: "production",
        adminKey: "test-admin",
      });
    },
    clientFactory: (url) => {
      assert.equal(url, config.target.url);
      return {
        setAdminAuth: (value) => assert.equal(value, "test-admin"),
        mutation: async (_fn, args) => {
          writes.push(args);
          return {
            inserted: args.rows.length,
            updated: 0,
            deleted: 0,
            unchanged: 0,
          };
        },
      };
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(writes.length, 1);
  assert.equal(result.inserted, result.rowCount);
  assert.ok(!JSON.stringify(result).includes("test-admin"));
});

test("a similarly named project in a different account never reaches authorization or mutation", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      importObservation(config, observation, {
        readAccessToken: () => "test-login",
        fetcher: async () => {
          calls++;
          return Response.json({ ...identity, teamId: 99 });
        },
        clientFactory: () => {
          throw Error("must not write");
        },
      }),
    /identity does not match/,
  );
  assert.equal(calls, 1);
});

test("a wrong custom domain stops before deployment authorization", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      importObservation(config, observation, {
        readAccessToken: () => "test-login",
        fetcher: async (url) => {
          calls++;
          return url.endsWith("team_and_project")
            ? Response.json(identity)
            : new Response("wrong-app-456");
        },
      }),
    /Custom domain/,
  );
  assert.equal(calls, 2);
});
