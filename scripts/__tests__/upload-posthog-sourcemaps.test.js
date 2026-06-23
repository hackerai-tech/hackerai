const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const scriptPath = path.join(
  process.cwd(),
  "scripts/upload-posthog-sourcemaps.mjs",
);

function createWorkspace({ cliExitCode }) {
  const cwd = mkdtempSync(path.join(tmpdir(), "posthog-sourcemaps-"));
  const binDir = path.join(cwd, "bin");

  mkdirSync(path.join(cwd, ".next"));
  mkdirSync(binDir);
  writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "hackerai-test" }),
  );
  writeFileSync(
    path.join(binDir, "posthog-cli"),
    `#!/bin/sh\necho "fake posthog-cli"\nexit ${cliExitCode}\n`,
    { mode: 0o755 },
  );

  return { cwd, binDir };
}

function runUpload({ cliExitCode = 0, env = {} } = {}) {
  const { cwd, binDir } = createWorkspace({ cliExitCode });

  try {
    return spawnSync(process.execPath, [scriptPath], {
      cwd,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        POSTHOG_CLI_API_KEY: "phx_test",
        POSTHOG_CLI_PROJECT_ID: "project_test",
        ...env,
      },
      encoding: "utf8",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("upload-posthog-sourcemaps", () => {
  test("continues the build when posthog-cli fails by default", () => {
    const result = runUpload({ cliExitCode: 1 });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "Source map upload failed with exit code 1",
    );
    expect(result.stderr).toContain("source map upload is best-effort");
  });

  test("fails when strict upload mode is enabled", () => {
    const result = runUpload({
      cliExitCode: 1,
      env: {
        POSTHOG_SOURCEMAP_UPLOAD_STRICT: "true",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Source map upload failed with exit code 1",
    );
    expect(result.stderr).not.toContain("source map upload is best-effort");
  });

  test("skips partial source map config unless strict upload mode is enabled", () => {
    const result = runUpload({
      env: {
        POSTHOG_CLI_PROJECT_ID: "",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "Source map upload requires both POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID. Skipping upload.",
    );
  });
});
