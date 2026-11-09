import { open, realpath } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";

// Read-only provider identity checks. Credentials never enter reports or errors.
export class TargetVerificationError extends Error {}
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;
const segment = (value) => encodeURIComponent(value);
function requireMatch(ok, message) {
  if (!ok) throw new TargetVerificationError(message);
}
async function readResponse(request, url, headers = {}, json = true) {
  let response;
  try {
    response = await request(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    requireMatch(response.ok, "Target identity request failed");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        requireMatch(
          size <= MAX_BYTES,
          "Target identity response exceeds limit",
        );
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return json ? JSON.parse(text) : text;
  } catch {
    throw new TargetVerificationError(
      "Target identity unavailable; no configuration was changed",
    );
  }
}

/** Verify live instance identity and provider-selected worker, never a TCP proxy. */
export async function verifyTargets(
  config,
  { env = process.env, request = fetch, root = process.cwd() } = {},
) {
  const { backend, worker } = config;
  // validateConfig owns URL/label validation before this function is called.
  requireMatch(
    ["local", "preview"].includes(config.environment),
    "Only local and Preview targets can be verified",
  );
  requireMatch(
    worker.environment ===
      (config.environment === "local" ? "development" : "preview"),
    "Worker environment mismatch",
  );
  requireMatch(
    env.TRIGGER_ACCESS_TOKEN,
    "TRIGGER_ACCESS_TOKEN is required for worker verification",
  );
  if (config.environment === "preview") {
    requireMatch(
      env.CONVEX_ACCESS_TOKEN,
      "CONVEX_ACCESS_TOKEN is required for backend verification",
    );
    const mapping = await readResponse(
      request,
      `https://api.convex.dev/api/deployment/${segment(backend.deployment)}/team_and_project`,
      { authorization: `Bearer ${env.CONVEX_ACCESS_TOKEN}` },
    );
    requireMatch(
      mapping.team === backend.account && mapping.project === backend.project,
      "Convex account/project mismatch",
    );
  } else {
    requireMatch(
      backend.account === "local",
      "Local backend account must be local",
    );
    requireMatch(
      ["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(backend.url).hostname,
      ),
      "Local backend must be loopback",
    );
  }
  if (config.environment === "local") {
    let state;
    try {
      const resolvedRoot = await realpath(root);
      const statePath = await realpath(
        join(root, ".convex/local/default/config.json"),
      );
      const rel = relative(resolvedRoot, statePath);
      requireMatch(
        !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`),
        "Local Convex state escapes this worktree",
      );
      const file = await open(statePath, "r");
      try {
        const info = await file.stat();
        requireMatch(
          info.isFile() && info.size <= MAX_BYTES,
          "Invalid local Convex state",
        );
        state = JSON.parse(await file.readFile("utf8"));
      } finally {
        await file.close();
      }
    } catch {
      throw new TargetVerificationError(
        "Worktree-local Convex state is unavailable",
      );
    }
    requireMatch(
      state.deploymentName === backend.deployment &&
        state.ports?.cloud === Number(new URL(backend.url).port),
      "Local Convex selection does not match this worktree",
    );
  }
  if (config.environment === "preview") {
    const deployment = await readResponse(
      request,
      `https://api.convex.dev/v1/deployments/${segment(backend.deployment)}`,
      { authorization: `Bearer ${env.CONVEX_ACCESS_TOKEN}` },
    );
    requireMatch(
      deployment.name === backend.deployment &&
        ["dev", "preview"].includes(deployment.deploymentType),
      "Convex deployment is not a designated development/Preview target",
    );
    requireMatch(
      deployment.deploymentUrl === backend.url,
      "Convex deployment URL mismatch",
    );
  }
  const instance = await readResponse(
    request,
    `${backend.url}/instance_name`,
    {},
    false,
  );
  requireMatch(
    instance === backend.deployment,
    "Running Convex deployment mismatch",
  );
  const headers = {
    authorization: `Bearer ${env.TRIGGER_ACCESS_TOKEN}`,
    "x-trigger-branch": worker.branch,
  };
  const project = await readResponse(
    request,
    `https://api.trigger.dev/api/v1/projects/${segment(worker.project)}`,
    headers,
  );
  requireMatch(
    project.externalRef === worker.project,
    "Trigger project mismatch",
  );
  const selected = await readResponse(
    request,
    `https://api.trigger.dev/api/v1/projects/${segment(worker.project)}/${worker.environment === "development" ? "dev" : "preview"}/workers/current`,
    headers,
  );
  requireMatch(
    selected.worker?.version === worker.version,
    "Trigger worker version mismatch",
  );
  requireMatch(
    typeof selected.worker?.id === "string",
    "Trigger worker identity missing",
  );
  return {
    capturedAt: new Date().toISOString(),
    backend: {
      ...backend,
      source: "live-instance-name",
      projectSource:
        config.environment === "local"
          ? "operator-declared"
          : "convex-control-plane",
      accountSource:
        config.environment === "preview"
          ? "convex-control-plane"
          : "local-only",
    },
    worker: { ...worker, source: "trigger-control-plane" },
    caveat:
      "Provider target verification does not prove native frontend, worker runtime configuration, or the transport used by an Agent run.",
  };
}
