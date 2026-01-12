#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const APP_URL = process.env.APP_URL || "https://hackerai.co";
const srcPath = path.join(__dirname, "../src/index.html");

const original = fs.readFileSync(srcPath, "utf-8");
const modified = original.replace(/__APP_URL__/g, APP_URL);

fs.writeFileSync(srcPath, modified);
console.log(`Building with APP_URL=${APP_URL}`);

try {
  const args = ["tauri", "build", ...process.argv.slice(2)];
  execFileSync("pnpm", args, {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
  });
} finally {
  fs.writeFileSync(srcPath, original);
}
