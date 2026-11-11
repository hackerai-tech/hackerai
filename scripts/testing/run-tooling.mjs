import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const suites = [
  {
    name: "research",
    files: [
      ".agents/skills/hackerai-user-research/scripts/run-research.test.mjs",
      ".agents/skills/hackerai-user-research/scripts/build-cohort.test.mjs",
    ],
  },
  {
    name: "desktop",
    files: [
      "scripts/desktop-qa/qa.test.mjs",
      "scripts/desktop-qa/verify-targets.test.mjs",
    ],
  },
  {
    name: "diagnostics",
    files: readdirSync(resolve(root, "scripts/diagnostics"))
      .filter((file) => file.endsWith(".test.mjs"))
      .map((file) => `scripts/diagnostics/${file}`),
  },
  {
    name: "markdown",
    files: readdirSync(resolve(root, "scripts/markdown"))
      .filter((file) => file.endsWith(".test.mjs"))
      .map((file) => `scripts/markdown/${file}`),
  },
  {
    name: "testing",
    files: readdirSync(resolve(root, "scripts/testing"))
      .filter((file) => file.endsWith(".test.mjs"))
      .map((file) => `scripts/testing/${file}`),
  },
  {
    name: "trigger-runtime",
    files: [
      "scripts/trigger-runtime/completion-ack.test.mjs",
      "scripts/trigger-runtime/child-completion.test.mjs",
      "scripts/trigger-runtime/child-flush.test.mjs",
      "scripts/trigger-runtime/s2-uncaught.test.mjs",
    ],
  },
];

/** Read every staged, unstaged and untracked dependency path; Git errors throw. */
export function changedFiles(cwd = root) {
  // Separate staged and unstaged diffs retain both sides of a partially staged
  // edit. Disable rename detection so both the old and new dependencies count.
  const commands = [
    ["diff", "--cached", "--name-only", "--no-renames", "-z"],
    ["diff", "--name-only", "--no-renames", "-z"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
  return [
    ...new Set(
      commands.flatMap((args) =>
        execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        })
          .split("\0")
          .filter(Boolean),
      ),
    ),
  ];
}

// The markdown suite bundles application modules into a real Streamdown render.
// Select it for the renderer owners; other application files keep the generic
// rule below and CI runs every suite.
const markdownRendererPaths = new Set([
  "app/components/MemoizedMarkdown.tsx",
  "app/components/SandboxAttachmentLink.tsx",
  "app/components/CodeHighlight.tsx",
  "app/components/MarkdownTable.tsx",
  "app/hooks/useAttachmentDownload.ts",
  "lib/chat/sandbox-attachment-links.ts",
]);

/** Select inspected tooling dependencies, falling back to all for unknown paths. */
export function selectSuites(paths) {
  const selected = new Set(["testing"]);
  for (const path of paths) {
    if (path.startsWith(".agents/skills/hackerai-user-research/"))
      selected.add("research");
    else if (
      path.startsWith("scripts/desktop-qa/") ||
      path.startsWith("packages/desktop/") ||
      path.startsWith(".agents/skills/hackerai-desktop-qa/") ||
      path === "scripts/verify-local-dependencies.mjs" ||
      path === "docs/desktop-local-acceptance.md"
    )
      selected.add("desktop");
    else if (
      path.startsWith("scripts/diagnostics/") ||
      path === "docs/safe-local-diagnostics.md"
    )
      selected.add("diagnostics");
    else if (
      path.startsWith("scripts/markdown/") ||
      markdownRendererPaths.has(path)
    )
      selected.add("markdown");
    // These tooling suites use isolated fixtures and do not import application
    // modules. Unknown paths (including configs, lockfiles and new tooling) run
    // everything; expand this allowlist only after inspecting dependencies.
    else if (/^(app|lib|convex|types|__mocks__|public|e2e)\//.test(path))
      continue;
    else return suites;
  }
  return suites.filter((suite) => selected.has(suite.name));
}

/** Run each selected Node suite serially and propagate the first failure. */
export function runSuites(selected, cwd = root) {
  for (const suite of selected) {
    console.log(`Tooling tests: ${suite.name}`);
    const result = spawnSync(process.execPath, ["--test", ...suite.files], {
      cwd,
      stdio: "inherit",
    });
    if (result.error || result.signal || result.status !== 0)
      return result.status || 1;
  }
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  let selected = suites;
  if (process.argv[2] === "--changed") {
    try {
      selected = selectSuites(changedFiles());
    } catch {
      console.warn("Changed files unavailable; running all tooling tests.");
    }
  } else if (process.argv.length > 2) {
    throw new Error("Usage: run-tooling.mjs [--changed]");
  }
  process.exitCode = runSuites(selected);
}
