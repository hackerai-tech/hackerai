import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { selectSuites, suites } from "./run-tooling.mjs";

export const languages = [
  "actions",
  "go",
  "javascript-typescript",
  "python",
  "rust",
];
const allTooling = suites.map((suite) => suite.name);
const critical =
  /^(convex\/|trigger\/|types\/|__mocks__\/|lib\/|app\/api\/|packages\/)/;

/** Compare committed PR content, including deletions and both sides of renames. */
export function changedSince(base, root = process.cwd()) {
  if (!/^[a-f0-9]{40}$/.test(base ?? ""))
    throw new Error("Invalid base commit");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  if (git(["cat-file", "-t", base]).trim() !== "commit")
    throw new Error("Base is not a commit");
  return git(["diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--"])
    .split("\0")
    .filter(Boolean);
}

/** Unknown inputs and shared configuration retain the complete safety pipeline. */
export function selectPlan(
  paths,
  { full = false, coverage = false, root = process.cwd() } = {},
) {
  const complete = () => ({
    jest: "full",
    typecheck: true,
    integrations: true,
    tooling: allTooling,
    languages,
    coverage,
  });
  if (full || paths === null) return complete();
  let jest = "none";
  let typecheck = false;
  let integrations = false;
  const tooling = new Set();
  const security = new Set();
  for (const path of paths) {
    if (/\.(?:py|go|rs)$/.test(path) && !/^packages\/desktop\//.test(path))
      return complete();
    if (
      /^scripts\/testing\//.test(path) ||
      /^\.github\/(workflows|actions)\//.test(path)
    )
      return complete();
    if (
      /^\.agents\/skills\/hackerai-user-research\//.test(path) ||
      /^scripts\/(desktop-qa|diagnostics)\//.test(path) ||
      /^\.agents\/skills\/hackerai-desktop-qa\//.test(path) ||
      [
        "docs/desktop-local-acceptance.md",
        "docs/safe-local-diagnostics.md",
      ].includes(path)
    ) {
      // These isolated suites currently execute JavaScript and JSON fixtures.
      // A new source/runtime type needs the broad checks until classified.
      if (!/\.(?:[cm]?js|json|md)$/.test(path)) return complete();
      for (const suite of selectSuites([path])) tooling.add(suite.name);
      if (/\.[cm]?js$/.test(path)) security.add("javascript-typescript");
      continue;
    }
    if (
      (/^docs\//.test(path) ||
        !path.includes("/") ||
        /^\.agents\//.test(path)) &&
      /\.md$/.test(path)
    )
      continue;
    if (
      /^public\//.test(path) &&
      /\.(png|jpe?g|webp|gif|svg|ico|woff2?|ttf)$/.test(path)
    )
      continue;
    if (/^docker\//.test(path)) return complete();
    if (critical.test(path)) {
      if (!/\.(?:[cm]?[jt]sx?|json|rs|toml|lock)$/.test(path))
        return complete();
      jest = "full";
      typecheck = integrations = true;
      for (const suite of selectSuites([path])) tooling.add(suite.name);
      security.add("javascript-typescript");
      if (/^packages\/desktop\//.test(path)) security.add("rust");
      continue;
    }
    if (/^app\//.test(path) && /\.(?:[cm]?[jt]sx?|css|scss)$/.test(path)) {
      if (!existsSync(resolve(root, path))) return complete();
      if (jest !== "full") jest = "related";
      typecheck = true;
      security.add("javascript-typescript");
      continue;
    }
    return complete();
  }
  return {
    jest,
    typecheck,
    integrations,
    tooling: allTooling.filter((name) => tooling.has(name)),
    languages: languages.filter((name) => security.has(name)),
    coverage,
  };
}

export function planForEvent(env = process.env, root = process.cwd()) {
  const full = env.GITHUB_EVENT_NAME !== "pull_request";
  const coverage = ["push", "schedule"].includes(env.GITHUB_EVENT_NAME);
  let paths = null;
  if (!full) {
    try {
      paths = changedSince(env.CI_BASE_SHA, root);
    } catch {
      /* Missing history never skips checks. */
    }
  }
  return selectPlan(paths, { full, coverage, root });
}

export function planOutputs(plan) {
  return {
    jest: plan.jest,
    typecheck: String(plan.typecheck),
    integrations: String(plan.integrations),
    tooling: String(plan.tooling.length > 0),
    tooling_suites: JSON.stringify(plan.tooling),
    security: String(plan.languages.length > 0),
    languages: JSON.stringify(
      plan.languages.length ? plan.languages : ["javascript-typescript"],
    ),
    coverage: String(plan.coverage),
    shards: JSON.stringify(plan.coverage ? [1] : [1, 2, 3, 4]),
    shard_count: plan.coverage ? "1" : "4",
  };
}

/** Intentional skips pass; a failed, missing, cancelled or unexpectedly skipped job fails. */
export function assertGate(needs) {
  if (needs.changes?.result !== "success")
    throw new Error("CI planning did not succeed");
  const outputs = needs.changes.outputs;
  for (const name of ["typecheck", "integrations", "tooling", "security"]) {
    if (!["true", "false"].includes(outputs?.[name]))
      throw new Error("Invalid CI plan");
  }
  if (!["none", "related", "full"].includes(outputs.jest))
    throw new Error("Invalid Jest plan");
  const expected = {
    typecheck: outputs.typecheck === "true",
    integrations: outputs.integrations === "true",
    tooling: outputs.tooling === "true",
    codeql: outputs.security === "true",
    jest: outputs.jest !== "none",
  };
  for (const [job, required] of Object.entries(expected)) {
    if (needs[job]?.result !== (required ? "success" : "skipped"))
      throw new Error(`CI job did not satisfy its plan: ${job}`);
  }
}
