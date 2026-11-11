import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function workflow(name) {
  return readFileSync(resolve(root, `.github/workflows/${name}.yml`), "utf8");
}

function triggers(source) {
  const match = source.match(/^on:[ \t]*\n((?:^[ \t]+.*\n|^\n)*)/m);
  assert.ok(match, "workflow must declare triggers");
  return match[1];
}

test("Desktop release and signing workflows cannot run branch-selected code", () => {
  const promotion = workflow("desktop-promote");
  const build = workflow("desktop-build");
  const request = workflow("desktop-build-request");

  assert.match(triggers(promotion), /^  repository_dispatch:/m);
  assert.doesNotMatch(triggers(promotion), /^  workflow_dispatch:/m);
  assert.match(triggers(build), /^  repository_dispatch:/m);
  assert.match(triggers(build), /^  workflow_run:/m);
  assert.doesNotMatch(triggers(build), /^  workflow_dispatch:/m);
  assert.doesNotMatch(triggers(build), /^  push:/m);
  assert.doesNotMatch(build, /^      contents: write$/m);
  assert.match(triggers(request), /^  push:/m);
  assert.match(triggers(request), /^    branches: \[main\]$/m);
  assert.doesNotMatch(request, /^\s+contents: write$/m);
});
