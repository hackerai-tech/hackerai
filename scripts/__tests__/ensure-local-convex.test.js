const {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const scriptPath = path.resolve("scripts/ensure-local-convex.mjs");

function runInitializer({ selectResult = "success", createExitCode = 0 } = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "ensure-local-convex-"));
  const capturePath = path.join(tempDir, "commands.jsonl");
  const fakePnpmPath = path.join(tempDir, "pnpm");

  try {
    writeFileSync(
      path.join(tempDir, "fake-pnpm.mjs"),
      `
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.CONVEX_COMMAND_CAPTURE, JSON.stringify(args) + "\\n");

if (args.includes("select")) {
  if (process.env.CONVEX_SELECT_RESULT === "missing") {
    console.error("No local deployment found. Run npx convex deployment create local to create one.");
    process.exit(1);
  }
  if (process.env.CONVEX_SELECT_RESULT === "error") {
    console.error("Authentication failed while selecting the deployment.");
    process.exit(2);
  }
  console.log("Selected local deployment.");
  process.exit(0);
}

console.log("Created and selected local deployment.");
process.exit(Number(process.env.CONVEX_CREATE_EXIT_CODE));
`,
    );
    writeFileSync(
      fakePnpmPath,
      `#!/bin/sh\nexec "${process.execPath}" "${path.join(tempDir, "fake-pnpm.mjs")}" "$@"\n`,
    );
    chmodSync(fakePnpmPath, 0o755);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: tempDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
        CONVEX_COMMAND_CAPTURE: capturePath,
        CONVEX_SELECT_RESULT: selectResult,
        CONVEX_CREATE_EXIT_CODE: String(createExitCode),
      },
    });
    const commands = readFileSync(capturePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    return { commands, result };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("ensure-local-convex", () => {
  const selectCommand = ["exec", "convex", "deployment", "select", "local"];
  const createCommand = [
    "exec",
    "convex",
    "deployment",
    "create",
    "local",
    "--select",
  ];

  test("reuses an existing local deployment", () => {
    const { commands, result } = runInitializer();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Selected local deployment.");
    expect(result.stderr).toBe("");
    expect(commands).toEqual([selectCommand]);
  });

  test("creates and selects a deployment only when none exists", () => {
    const { commands, result } = runInitializer({ selectResult: "missing" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "No local deployment found; creating one for this worktree.",
    );
    expect(commands).toEqual([selectCommand, createCommand]);
  });

  test("does not create a deployment for unrelated selection failures", () => {
    const { commands, result } = runInitializer({ selectResult: "error" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "Authentication failed while selecting the deployment.",
    );
    expect(commands).toEqual([selectCommand]);
  });

  test("propagates local deployment creation failures", () => {
    const { commands, result } = runInitializer({
      selectResult: "missing",
      createExitCode: 3,
    });

    expect(result.status).toBe(3);
    expect(commands).toEqual([selectCommand, createCommand]);
  });
});
