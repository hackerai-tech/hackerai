#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const readGit = (args) => {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  return result.status === 0 ? result.stdout.trim() : "";
};

const sanitizeBranchName = (value) => {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

  return normalized || "local";
};

const branchFromGit =
  readGit(["branch", "--show-current"]) ||
  [path.basename(process.cwd()), readGit(["rev-parse", "--short", "HEAD"])]
    .filter(Boolean)
    .join("-");

const triggerBranch = sanitizeBranchName(
  process.env.TRIGGER_DEV_BRANCH || branchFromGit || "local",
);

console.log(`[trigger-dev] using Trigger.dev branch: ${triggerBranch}`);

const child = spawn(
  "trigger",
  ["dev", "--branch", triggerBranch, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(
    `[trigger-dev] failed to start Trigger.dev CLI: ${error.message}`,
  );
  process.exit(1);
});
