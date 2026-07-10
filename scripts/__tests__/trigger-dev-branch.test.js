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

const scriptPath = path.resolve("scripts/trigger-dev-branch.mjs");

describe("trigger-dev-branch", () => {
  it("starts the Trigger 4.5 dev branch with forwarded arguments", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "trigger-dev-branch-"));
    const capturePath = path.join(tempDir, "args.json");

    try {
      writeFileSync(
        path.join(tempDir, "capture-trigger.mjs"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.TRIGGER_ARGS_CAPTURE, JSON.stringify(process.argv.slice(2)));\n`,
      );
      writeFileSync(
        path.join(tempDir, "trigger"),
        `#!/bin/sh\nexec "${process.execPath}" "${path.join(tempDir, "capture-trigger.mjs")}" "$@"\n`,
      );
      chmodSync(path.join(tempDir, "trigger"), 0o755);

      const result = spawnSync(
        process.execPath,
        [scriptPath, "--skip-update-check"],
        {
          cwd: tempDir,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${tempDir}:${process.env.PATH}`,
            TRIGGER_ARGS_CAPTURE: capturePath,
            TRIGGER_DEV_BRANCH: "feature/codex health",
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(
        "[trigger-dev] using Trigger.dev branch: feature-codex-health",
      );
      expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual([
        "dev",
        "start",
        "--branch",
        "feature-codex-health",
        "--skip-update-check",
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
