import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReviewMerge } from "./review-equivalence.mjs";

test("real Git merge proof accepts base refresh and rejects edits, conflicts, unrelated heads and missing objects", () => {
  const cwd = mkdtempSync(join(tmpdir(), "review-proof-test-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
    }).trim();
  const commit = (file, content) => {
    writeFileSync(join(cwd, file), content);
    git("add", file);
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q", "--template=", "-b", "main");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    const initial = commit("app.txt", "before\n");
    git("checkout", "-qb", "feature");
    const reviewed = commit("app.txt", "reviewed\n");
    git("checkout", "-q", "main");
    const base = commit("base.txt", "base update\n");
    git("checkout", "-q", "feature");
    git("merge", "--no-ff", "-qm", "base refresh", base);
    const head = git("rev-parse", "HEAD");
    assert.equal(verifyReviewMerge(reviewed, base, head, { cwd }), true);
    const inherited = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = "/nonexistent-review-gate-fixture";
      assert.equal(verifyReviewMerge(reviewed, base, head, { cwd }), true);
    } finally {
      if (inherited === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = inherited;
    }
    const edited = commit("extra.txt", "unreviewed\n");
    assert.equal(verifyReviewMerge(reviewed, base, edited, { cwd }), false);
    git("checkout", "-qb", "conflict", initial);
    const conflicting = commit("app.txt", "conflicting base\n");
    git("checkout", "-q", "feature");
    assert.throws(() => git("merge", "--no-ff", "-m", "conflict", conflicting));
    const resolved = commit("app.txt", "reviewed\n");
    assert.equal(
      verifyReviewMerge(reviewed, conflicting, resolved, { cwd }),
      false,
    );
    assert.equal(verifyReviewMerge(reviewed, base, initial, { cwd }), false);
    assert.equal(verifyReviewMerge("f".repeat(40), base, head, { cwd }), false);
    assert.equal(verifyReviewMerge("HEAD;exit", base, head, { cwd }), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
