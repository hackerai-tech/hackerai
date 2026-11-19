import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { changedSince, selectPlan } from "./ci-plan.mjs";

const source = /\.[cm]?[jt]sx?$/;
const configuration =
  /^(?:eslint\.config\.|\.eslint|\.github\/|scripts\/testing\/|package\.json$|pnpm-|tsconfig)/;

/** Config changes and unavailable history lint every tracked first-party source. */
export function lintTargets(paths, tracked, root) {
  const full =
    paths === null ||
    paths.some((path) => configuration.test(path)) ||
    selectPlan(paths, { root }).jest === "full";
  return (full ? tracked : paths).filter(
    (path) =>
      source.test(path) &&
      !path.startsWith("third_party/") &&
      existsSync(resolve(root, path)),
  );
}

export async function runLint(env = process.env, root = process.cwd()) {
  let changed = null;
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    try {
      changed = changedSince(env.CI_BASE_SHA, root);
    } catch {
      /* Full fallback. */
    }
  }
  const gitEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\0")
    .filter(Boolean);
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: root, globInputPaths: false });
  const targets = [];
  for (const path of lintTargets(changed, tracked, root)) {
    if (!(await eslint.isPathIgnored(path))) targets.push(path);
  }
  if (!targets.length) {
    console.log("No applicable lint sources.");
    return 0;
  }
  const results = await eslint.lintFiles(targets);
  const formatter = await eslint.loadFormatter("stylish");
  console.log(formatter.format(results));
  console.log(`Linted ${results.length} source files without autofix.`);
  return results.some(
    (result) => result.errorCount > 0 || result.fatalErrorCount > 0,
  )
    ? 1
    : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = await runLint();
  } catch {
    console.error("Lint could not complete; failing closed.");
    process.exitCode = 1;
  }
}
