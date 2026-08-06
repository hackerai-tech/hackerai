const {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const scriptPath = path.resolve("scripts/verify-local-dependencies.mjs");

function createProject({
  createNodeModules = true,
  packageJson = { dependencies: { next: "test" } },
} = {}) {
  const projectRoot = mkdtempSync(
    path.join(tmpdir(), "verify-local-dependencies-"),
  );

  if (createNodeModules) {
    mkdirSync(path.join(projectRoot, "node_modules"));
  }
  writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify(packageJson),
  );

  return projectRoot;
}

function runGuard(projectRoot) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

describe("verify-local-dependencies", () => {
  const cleanupPaths = [];

  afterEach(() => {
    for (const cleanupPath of cleanupPaths.splice(0)) {
      rmSync(cleanupPath, { recursive: true, force: true });
    }
  });

  test("accepts dependency links within the current checkout", () => {
    const projectRoot = createProject();
    cleanupPaths.push(projectRoot);
    const localTarget = path.join(
      projectRoot,
      "node_modules/.pnpm/next/node_modules/next",
    );

    mkdirSync(localTarget, { recursive: true });
    symlinkSync(
      ".pnpm/next/node_modules/next",
      path.join(projectRoot, "node_modules/next"),
      "dir",
    );

    const result = runGuard(projectRoot);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Local dependency links are scoped to this checkout.",
    );
  });

  test("rejects relative dependency links into another checkout", () => {
    const projectRoot = createProject();
    const otherCheckout = mkdtempSync(
      path.join(tmpdir(), "other-hackerai-checkout-"),
    );
    cleanupPaths.push(projectRoot, otherCheckout);
    const externalTarget = path.join(otherCheckout, "node_modules/next");
    const dependencyDirectory = path.join(projectRoot, "node_modules");

    mkdirSync(externalTarget, { recursive: true });
    symlinkSync(
      path.relative(dependencyDirectory, externalTarget),
      path.join(dependencyDirectory, "next"),
      "dir",
    );

    const result = runGuard(projectRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Local dependencies are linked outside this checkout:",
    );
    expect(result.stderr).toContain(`next -> ${realpathSync(externalTarget)}`);
    expect(result.stderr).toContain(
      "corepack pnpm install --force --frozen-lockfile",
    );
  });

  test("rejects an entire node_modules link into another checkout", () => {
    const projectRoot = createProject({ createNodeModules: false });
    const otherCheckout = mkdtempSync(
      path.join(tmpdir(), "other-hackerai-checkout-"),
    );
    cleanupPaths.push(projectRoot, otherCheckout);
    const externalNodeModules = path.join(otherCheckout, "node_modules");

    mkdirSync(path.join(externalNodeModules, "next"), { recursive: true });
    symlinkSync(
      path.relative(projectRoot, externalNodeModules),
      path.join(projectRoot, "node_modules"),
      "dir",
    );

    const result = runGuard(projectRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `node_modules -> ${realpathSync(externalNodeModules)}`,
    );
  });

  test("reports an incomplete install with the normal install command", () => {
    const projectRoot = createProject();
    cleanupPaths.push(projectRoot);

    const result = runGuard(projectRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Local dependencies are incomplete");
    expect(result.stderr).toContain("corepack pnpm install --frozen-lockfile");
  });

  test("allows platform-specific optional dependencies to be absent", () => {
    const projectRoot = createProject({
      packageJson: { optionalDependencies: { optional: "test" } },
    });
    cleanupPaths.push(projectRoot);

    const result = runGuard(projectRoot);

    expect(result.status).toBe(0);
  });
});
