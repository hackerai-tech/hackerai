import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./lint-ci.mjs", import.meta.url));
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "hackerai-lint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
      {
        cwd: root,
        env: cleanEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init");
  put("eslint.config.mjs", 'export default [{rules:{"no-debugger":"error"}}];');
  return {
    root,
    put,
    commit,
    git,
    run: (base, event = "pull_request") =>
      spawnSync(process.execPath, [script], {
        cwd: root,
        env: { ...cleanEnv, GITHUB_EVENT_NAME: event, CI_BASE_SHA: base },
        encoding: "utf8",
      }),
  };
}

test("actual ESLint fails a committed source violation on a clean checkout without fixing it", (t) => {
  const f = fixture(t);
  f.put("app/[route]/page.js", "export const value = 1;\n");
  const base = f.commit();
  f.put("app/[route]/page.js", "debugger;\n");
  f.commit();
  assert.equal(f.git("status", "--porcelain"), "");
  const result = f.run(base);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no-debugger/);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("config changes, main runs and missing history inspect unchanged sources too", (t) => {
  const f = fixture(t);
  f.put("app/legacy.js", "debugger;\n");
  const base = f.commit();
  f.put(
    "eslint.config.mjs",
    'export default [{rules:{"no-debugger":"error"}}];\n',
  );
  f.commit();
  assert.equal(f.run(base).status, 1);
  assert.equal(f.run("unknown").status, 1);
  assert.equal(f.run(base, "push").status, 1);
  const next = f.git("rev-parse", "HEAD");
  f.put("unknown-config.json", "{}\n");
  f.commit();
  assert.equal(f.run(next).status, 1);
});

test("deleted sources are not lint targets and changed tooling is linted", (t) => {
  const f = fixture(t);
  f.put("app/deleted.js", "debugger;\n");
  const base = f.commit();
  rmSync(join(f.root, "app/deleted.js"));
  f.commit();
  assert.equal(f.run(base).status, 0);
  const next = f.git("rev-parse", "HEAD");
  f.put("scripts/new.mjs", "debugger;\n");
  f.commit();
  assert.equal(f.run(next).status, 1);
});
