import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  changedSince,
  selectPlan,
  planForEvent,
  planOutputs,
} from "./ci-plan.mjs";
import { jestArgs } from "./ci.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
const all = selectPlan(null);

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), "hackerai-ci-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=CI fixture",
        "-c",
        "user.email=ci@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const put = (path, content = "export const value = 1;") => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init");
  return { cwd, git, put, commit };
}

test("committed PR changes are selected on a clean checkout, including deleted and renamed paths", (t) => {
  const fixture = repository(t);
  fixture.put("app/old.ts");
  fixture.put("app/deleted.ts");
  const base = fixture.commit();
  renameSync(join(fixture.cwd, "app/old.ts"), join(fixture.cwd, "app/new.ts"));
  rmSync(join(fixture.cwd, "app/deleted.ts"));
  fixture.put("app/with\nnewline.ts");
  fixture.commit();
  assert.equal(fixture.git("status", "--porcelain"), "");
  assert.deepEqual(
    changedSince(base, fixture.cwd).sort(),
    [
      "app/deleted.ts",
      "app/new.ts",
      "app/old.ts",
      "app/with\nnewline.ts",
    ].sort(),
  );
  // A removed module can break consumers no longer represented by Jest's graph.
  assert.equal(
    planForEvent(
      { GITHUB_EVENT_NAME: "pull_request", CI_BASE_SHA: base },
      fixture.cwd,
    ).jest,
    "full",
  );
});

test("a committed frontend edit uses related tests even when the working tree is clean", (t) => {
  const fixture = repository(t);
  fixture.put("app/view.tsx");
  const base = fixture.commit();
  fixture.put("app/view.tsx", "export const value = 2;");
  fixture.commit();
  const plan = planForEvent(
    { GITHUB_EVENT_NAME: "pull_request", CI_BASE_SHA: base },
    fixture.cwd,
  );
  assert.equal(plan.jest, "related");
  assert.equal(plan.typecheck, true);
  assert.deepEqual(plan.languages, ["javascript-typescript"]);
  assert.deepEqual(JSON.parse(planOutputs(plan).shards), [1]);
  assert.equal(planOutputs(plan).shard_count, "1");
  const args = jestArgs({
    mode: plan.jest,
    shard: "1/1",
    coverage: false,
    paths: changedSince(base, fixture.cwd),
  });
  assert.deepEqual(args.slice(-2), ["--findRelatedTests", "app/view.tsx"]);
});

test("missing history, shared configuration and unknown executable paths retain all checks", () => {
  assert.deepEqual(
    planForEvent({ GITHUB_EVENT_NAME: "pull_request", CI_BASE_SHA: "missing" }),
    all,
  );
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "jest.config.ts",
    ".github/workflows/test.yml",
    "scripts/testing/ci.mjs",
    "docker/install_trivy.sh",
    "docs/helper.py",
    "scripts/diagnostics/new.ts",
    ".agents/skills/hackerai-user-research/scripts/new.sh",
    "third_party/strix-skills/skills/new/SKILL.md",
    "lib/ai/subagents/skills/new/SKILL.md",
    "lib/helper.py",
    "lib/new.wasm",
    ".agents/new/run.mjs",
    "new-directory/source.go",
  ]) {
    assert.deepEqual(selectPlan([path]), all, path);
  }
});

test("shared runtime and desktop changes retain their safety integrations and security languages", () => {
  for (const path of [
    "convex/chat.ts",
    "trigger/agent.ts",
    "lib/api/agent-stream-runner.ts",
    "app/api/chat/route.ts",
    "app/services/agent-run-cancellation.ts",
    "types/chat.ts",
  ]) {
    const plan = selectPlan([path]);
    assert.equal(plan.jest, "full", path);
    assert.equal(plan.integrations, true, path);
    assert.equal(plan.typecheck, true, path);
    assert.ok(plan.languages.includes("javascript-typescript"), path);
  }
  assert.ok(
    selectPlan(["packages/desktop/src-tauri/src/main.rs"]).languages.includes(
      "rust",
    ),
  );
});

test("executable skill tooling is covered while ordinary prose can skip runtime jobs", () => {
  const plan = selectPlan([
    ".agents/skills/hackerai-user-research/scripts/run-research.mjs",
  ]);
  assert.ok(plan.tooling.includes("research"));
  assert.deepEqual(plan.languages, ["javascript-typescript"]);
  for (const paths of [
    ["README.md"],
    ["docs/architecture.md"],
    [".agents/skills/hackerai-code-first-engineering/SKILL.md"],
  ]) {
    const prose = selectPlan(paths);
    assert.equal(prose.jest, "none");
    assert.equal(prose.typecheck, false);
    assert.equal(prose.integrations, false);
    assert.deepEqual(prose.tooling, []);
    assert.deepEqual(prose.languages, []);
  }
});

test("main and nightly retain full coverage; manual runs retain the complete PR workload", () => {
  for (const event of ["push", "schedule", "workflow_dispatch"]) {
    const plan = planForEvent({ GITHUB_EVENT_NAME: event });
    assert.equal(plan.jest, "full");
    assert.deepEqual(plan.languages, all.languages);
    assert.deepEqual(plan.tooling, all.tooling);
    assert.equal(plan.coverage, event !== "workflow_dispatch");
  }
  assert.deepEqual(
    JSON.parse(planOutputs(planForEvent({ GITHUB_EVENT_NAME: "push" })).shards),
    [1],
  );
  assert.deepEqual(JSON.parse(planOutputs(all).shards), [1, 2, 3, 4]);
  assert.throws(() => jestArgs({ mode: "related", shard: "1/4", paths: [] }));
});

function results(plan) {
  const outputs = planOutputs(plan);
  return {
    changes: { result: "success", outputs },
    typecheck: { result: plan.typecheck ? "success" : "skipped" },
    integrations: { result: plan.integrations ? "success" : "skipped" },
    tooling: { result: plan.tooling.length ? "success" : "skipped" },
    codeql: { result: plan.languages.length ? "success" : "skipped" },
    jest: { result: plan.jest !== "none" ? "success" : "skipped" },
  };
}

function gate(needs) {
  return spawnSync(process.execPath, ["scripts/testing/ci.mjs", "gate"], {
    cwd: root,
    env: { ...env, CI_NEEDS: JSON.stringify(needs) },
    encoding: "utf8",
  });
}

test("the actual aggregate command accepts intentional skips and fails closed for every missing or unsuccessful prerequisite", () => {
  assert.equal(gate(results(all)).status, 0);
  assert.equal(gate(results(selectPlan(["README.md"]))).status, 0);
  for (const job of [
    "changes",
    "typecheck",
    "integrations",
    "tooling",
    "codeql",
    "jest",
  ]) {
    for (const result of ["failure", "cancelled", "skipped", undefined]) {
      const needs = results(all);
      if (result) needs[job].result = result;
      else delete needs[job];
      assert.notEqual(gate(needs).status, 0, `${job}: ${result}`);
    }
  }
  const needs = results(all);
  delete needs.changes.outputs.security;
  assert.notEqual(gate(needs).status, 0);
  const failed = results(all);
  failed.jest.result = "failure";
  assert.match(gate(failed).stderr, /CI job did not satisfy its plan: jest/);
  const malformed = spawnSync(
    process.execPath,
    ["scripts/testing/ci.mjs", "gate"],
    {
      cwd: root,
      env: { ...env, CI_NEEDS: "invalid-private-sentinel" },
      encoding: "utf8",
    },
  );
  assert.notEqual(malformed.status, 0);
  assert.doesNotMatch(malformed.stderr, /invalid-private-sentinel/);
});
