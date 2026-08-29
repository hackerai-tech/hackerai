const { spawnSync } = require("node:child_process");
const {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const repositoryRoot = path.resolve(".");
const isolatedGitEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: isolatedGitEnvironment,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout;
}

function createFixture({ changeSkill = false } = {}) {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "sync-strix-skills-test-"),
  );
  const projectRoot = path.join(temporaryRoot, "project");
  const upstreamRoot = path.join(temporaryRoot, "upstream");

  mkdirSync(path.join(projectRoot, "scripts"), { recursive: true });
  mkdirSync(path.join(projectRoot, "lib/ai/subagents/skills"), {
    recursive: true,
  });
  cpSync(
    path.join(repositoryRoot, "scripts/sync-strix-skills.mjs"),
    path.join(projectRoot, "scripts/sync-strix-skills.mjs"),
  );
  cpSync(
    path.join(repositoryRoot, "third_party/strix-skills"),
    path.join(projectRoot, "third_party/strix-skills"),
    { recursive: true },
  );
  for (const filename of [
    "strix-skill-catalog.generated.json",
    "strix-skill-content.generated.json",
  ]) {
    cpSync(
      path.join(repositoryRoot, "lib/ai/subagents/skills", filename),
      path.join(projectRoot, "lib/ai/subagents/skills", filename),
    );
  }

  mkdirSync(path.join(upstreamRoot, "strix"), { recursive: true });
  cpSync(
    path.join(repositoryRoot, "third_party/strix-skills/skills"),
    path.join(upstreamRoot, "strix/skills"),
    { recursive: true },
  );
  cpSync(
    path.join(repositoryRoot, "third_party/strix-skills/LICENSE"),
    path.join(upstreamRoot, "LICENSE"),
  );
  if (changeSkill) {
    appendFileSync(
      path.join(upstreamRoot, "strix/skills/vulnerabilities/xss.md"),
      "\n\nRegression material-change marker.\n",
    );
  }

  run("git", ["init", "-q"], upstreamRoot);
  run("git", ["config", "user.name", "Regression Test"], upstreamRoot);
  run(
    "git",
    ["config", "user.email", "regression@example.invalid"],
    upstreamRoot,
  );
  run("git", ["add", "."], upstreamRoot);
  run("git", ["commit", "-qm", "upstream fixture"], upstreamRoot);

  return {
    projectRoot,
    sourceCommit: run("git", ["rev-parse", "HEAD"], upstreamRoot).trim(),
    temporaryRoot,
    upstreamRoot,
  };
}

describe("sync-strix-skills", () => {
  const cleanupPaths = [];

  afterEach(() => {
    for (const cleanupPath of cleanupPaths.splice(0)) {
      rmSync(cleanupPath, { recursive: true, force: true });
    }
  });

  test("does not update provenance when the imported snapshot is unchanged", () => {
    const fixture = createFixture();
    cleanupPaths.push(fixture.temporaryRoot);
    const manifestPath = path.join(
      fixture.projectRoot,
      "third_party/strix-skills/UPSTREAM.json",
    );
    const before = readFileSync(manifestPath, "utf8");

    const output = run(
      process.execPath,
      ["scripts/sync-strix-skills.mjs", "--source", fixture.upstreamRoot],
      fixture.projectRoot,
    );

    expect(fixture.sourceCommit).not.toBe(JSON.parse(before).sourceCommit);
    expect(output).toContain("No Strix skill changes");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  test("updates provenance and generated content for a material skill change", () => {
    const fixture = createFixture({ changeSkill: true });
    cleanupPaths.push(fixture.temporaryRoot);

    run(
      process.execPath,
      ["scripts/sync-strix-skills.mjs", "--source", fixture.upstreamRoot],
      fixture.projectRoot,
    );

    const manifest = JSON.parse(
      readFileSync(
        path.join(
          fixture.projectRoot,
          "third_party/strix-skills/UPSTREAM.json",
        ),
        "utf8",
      ),
    );
    const generatedContent = readFileSync(
      path.join(
        fixture.projectRoot,
        "lib/ai/subagents/skills/strix-skill-content.generated.json",
      ),
      "utf8",
    );
    const checkOutput = run(
      process.execPath,
      ["scripts/sync-strix-skills.mjs", "--check"],
      fixture.projectRoot,
    );

    expect(manifest.sourceCommit).toBe(fixture.sourceCommit);
    expect(generatedContent).toContain("Regression material-change marker.");
    expect(checkOutput).toContain("Verified 52 selectable Strix skills");
  });
});
