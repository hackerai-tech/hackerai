#!/usr/bin/env node

import { spawn } from "node:child_process";

const sanitizeBranchName = (value) => {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

  return normalized || "local";
};

const configuredBranch = process.env.TRIGGER_DEV_BRANCH?.trim();
const triggerArgs = ["dev", "start"];

if (configuredBranch) {
  const triggerBranch = sanitizeBranchName(configuredBranch);
  triggerArgs.push("--branch", triggerBranch);
  console.log(
    `[trigger-dev] using explicit Trigger.dev branch: ${triggerBranch}`,
  );
} else {
  console.log("[trigger-dev] using default Trigger.dev branch");
}

const child = spawn("trigger", [...triggerArgs, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

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
