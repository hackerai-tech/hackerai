#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { prepareOperatingImport } from "../../lib/billing/operating-costs.ts";

function readPrivateJson(file) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    stat.size > 1_000_000
  ) {
    throw new Error("A private regular JSON file is required");
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function validateTarget(config) {
  const t = config?.target;
  if (
    !["production", "preview"].includes(t?.environment) ||
    !/^[a-z0-9-]+$/.test(t.deployment ?? "") ||
    t.url !== `https://${t.deployment}.convex.cloud` ||
    !/^[a-z0-9-]+$/.test(t.team ?? "") ||
    !/^[a-z0-9-]+$/.test(t.project ?? "") ||
    !Number.isSafeInteger(t.teamId) ||
    !Number.isSafeInteger(t.projectId) ||
    !(t.environment === "production"
      ? t.reference === "production"
      : /^preview\//.test(t.reference ?? ""))
  ) {
    throw new Error(
      "Explicit account, project and deployment identity is required",
    );
  }
  if (t.customDomain && new URL(t.customDomain).protocol !== "https:")
    throw new Error("Invalid custom domain");
  return t;
}

export async function importObservation(
  config,
  observation,
  {
    dryRun = false,
    fetcher = fetch,
    clientFactory = (url) => new ConvexHttpClient(url, { logger: false }),
    readAccessToken = () =>
      JSON.parse(
        fs.readFileSync(path.join(os.homedir(), ".convex/config.json"), "utf8"),
      ).accessToken,
  } = {},
) {
  const target = validateTarget(config);
  const prepared = prepareOperatingImport(observation, config.sources ?? {});
  const summary = {
    environment: target.environment,
    team: target.team,
    project: target.project,
    deployment: target.deployment,
    vendor: prepared.vendor,
    startDay: prepared.startDay,
    endDay: prepared.endDay,
    rowCount: prepared.rows.length,
    recognizedDollars:
      Math.round(
        prepared.rows.reduce(
          (n, r) => n + (r.billedCostDollars ?? r.effectiveCostDollars ?? 0),
          0,
        ) * 1e6,
      ) / 1e6,
  };
  if (dryRun) return { ...summary, dryRun: true };

  // Reuse the operator's Convex login. No app secret or vendor session is copied.
  const accessToken = readAccessToken();
  if (typeof accessToken !== "string" || !accessToken)
    throw new Error("Convex operator login is unavailable");
  const management = async (endpoint, body) => {
    const response = await fetcher(`https://api.convex.dev/api/${endpoint}`, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error("Convex account authorization failed");
    return response.json();
  };
  const identity = await management(
    `deployment/${target.deployment}/team_and_project`,
  );
  if (
    identity.team !== target.team ||
    identity.project !== target.project ||
    identity.teamId !== target.teamId ||
    identity.projectId !== target.projectId ||
    identity.reference !== target.reference
  ) {
    throw new Error("Deployment identity does not match the approved target");
  }
  if (target.customDomain) {
    const response = await fetcher(
      `${target.customDomain.replace(/\/$/, "")}/instance_name`,
      { redirect: "error", signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok || (await response.text()) !== target.deployment)
      throw new Error("Custom domain does not reach the approved target");
  }
  const authorization = await management(
    "deployment/authorize_within_current_project",
    {
      selectedDeploymentName: target.deployment,
      projectSelection: {
        kind: "deploymentName",
        deploymentName: target.deployment,
      },
    },
  );
  if (
    authorization.url !== target.url ||
    authorization.deploymentName !== target.deployment ||
    authorization.reference !== target.reference ||
    typeof authorization.adminKey !== "string"
  ) {
    throw new Error("Authorized deployment differs from the verified target");
  }
  const client = clientFactory(target.url);
  client.setAdminAuth(authorization.adminKey);
  const result = await client.mutation(
    makeFunctionReference("operatingCosts:importBillingWindow"),
    prepared,
  );
  return { ...summary, dryRun: false, ...result };
}

async function main() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config"),
    snapshotIndex = args.indexOf("--snapshot");
  if (
    configIndex < 0 ||
    snapshotIndex < 0 ||
    !args[configIndex + 1] ||
    !args[snapshotIndex + 1]
  ) {
    throw new Error(
      "Usage: node scripts/billing/import-operating-costs.mjs --config <private-json> --snapshot <private-json> [--dry-run]",
    );
  }
  const result = await importObservation(
    readPrivateJson(args[configIndex + 1]),
    readPrivateJson(args[snapshotIndex + 1]),
    { dryRun: args.includes("--dry-run") },
  );
  console.log(JSON.stringify(result));
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch(() => {
    // API exceptions may include tokens or invoice payloads. Never print them.
    console.error(
      JSON.stringify({
        event: "operating_cost_import_failed",
        error:
          "Validate snapshot, source freshness and explicit deployment identity; no automatic replay",
      }),
    );
    process.exitCode = 1;
  });
}
