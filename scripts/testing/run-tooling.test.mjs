import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  changedFiles,
  runSuites,
  selectSuites,
  suites,
} from "./run-tooling.mjs";

const names = (paths) => selectSuites(paths).map((suite) => suite.name);
test("application changes skip isolated tooling but tooling dependencies and unknown files cannot", () => {
  assert.deepEqual(names(["lib/api/chat-logger.ts", "app/chat/page.tsx"]), [
    "testing",
  ]);
  assert.deepEqual(
    names(["scripts/desktop-qa/qa.mjs", "docs/safe-local-diagnostics.md"]),
    ["desktop", "diagnostics", "testing"],
  );
  assert.deepEqual(names([".agents/skills/hackerai-user-research/SKILL.md"]), [
    "research",
    "testing",
  ]);
  assert.deepEqual(names(["scripts/verify-local-dependencies.mjs"]), [
    "desktop",
    "testing",
  ]);
  for (const path of [
    "scripts/markdown/sandbox-download.fixture.tsx",
    "app/components/MemoizedMarkdown.tsx",
    "lib/chat/sandbox-attachment-links.ts",
  ]) {
    assert.deepEqual(names([path]), ["markdown", "testing"], path);
  }
  assert.deepEqual(names(["app/components/MessageItem.tsx"]), ["testing"]);
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "jest.setup.js",
    "unknown/helper.mjs",
    "scripts/new-tool.mjs",
    ".github/workflows/test.yml",
  ]) {
    assert.deepEqual(selectSuites([path]), suites);
  }
});

test("collects staged, unstaged, deleted, renamed and untracked paths without quoting corruption", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "test-selection-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Hooks export Git selectors. Never let fixture operations inherit the real
  // repository or its index when creating an isolated temporary repository.
  const gitEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe", env: gitEnvironment });
  git("init", "-q");
  for (const name of ["partial", "renamed", "deleted"])
    writeFileSync(join(dir, name), "initial");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  );
  writeFileSync(join(dir, "partial"), "staged");
  git("add", "partial");
  writeFileSync(join(dir, "partial"), "initial");
  renameSync(join(dir, "renamed"), join(dir, "new name\nwith newline"));
  rmSync(join(dir, "deleted"));
  writeFileSync(join(dir, "untracked"), "new");
  assert.deepEqual(
    (() => {
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")),
      );
      for (const key of Object.keys(inherited)) delete process.env[key];
      try {
        return changedFiles(dir).sort();
      } finally {
        Object.assign(process.env, inherited);
      }
    })(),
    [
      "partial",
      "renamed",
      "new name\nwith newline",
      "deleted",
      "untracked",
    ].sort(),
  );
});

test("each tooling runner propagates a real failing Node test instead of reporting success", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tooling-failure-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "fail.mjs"),
    "import { test } from 'node:test'; test('injected failure', () => { throw Error('expected fixture failure'); });",
  );
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
  });
  for (const suite of suites)
    assert.notEqual(runSuites([{ ...suite, files: ["fail.mjs"] }], dir), 0);
  assert.throws(() => changedFiles(join(dir, "missing")));
});
