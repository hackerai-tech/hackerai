import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dockerfilePath = resolve(process.cwd(), "docker/Dockerfile");
const dockerfile = readFileSync(dockerfilePath, "utf8");

function parseInstructions(source: string): string[] {
  const instructions: string[] = [];
  let current = "";

  for (const line of source.split("\n")) {
    if (/^\s*(?:#.*)?$/.test(line)) {
      continue;
    }

    current += `${current ? "\n" : ""}${line}`;

    if (!line.trimEnd().endsWith("\\")) {
      instructions.push(current);
      current = "";
    }
  }

  return instructions;
}

const instructions = parseInstructions(dockerfile);
const runInstructions = instructions.filter((instruction) =>
  instruction.startsWith("RUN "),
);

function findRun(fragment: string): string {
  const instruction = runInstructions.find((run) => run.includes(fragment));

  if (!instruction) {
    throw new Error(
      `Missing Dockerfile RUN instruction containing: ${fragment}`,
    );
  }

  return instruction;
}

describe("sandbox Dockerfile cache cleanup", () => {
  test("removes apt metadata in every apt installation layer", () => {
    const aptRuns = runInstructions.filter(
      (run) =>
        run.includes("apt-get install") || run.includes("apt-get upgrade"),
    );

    expect(aptRuns).not.toHaveLength(0);
    for (const run of aptRuns) {
      expect(run).toContain("apt-get clean");
      expect(run).toContain("/var/lib/apt/lists/*");
      expect(run).toContain("/var/cache/apt/archives/*");
    }
  });

  test("disables pip's download cache for every package installation", () => {
    const pipCommands = runInstructions.flatMap((run) =>
      run.split("&&").filter((command) => command.includes("pip3 install")),
    );

    expect(pipCommands).not.toHaveLength(0);
    for (const command of pipCommands) {
      expect(command).toContain("--no-cache-dir");
    }
  });

  test("removes the temporary npm cache before validating agent-browser", () => {
    const npmRun = findRun("agent-browser@0.26.0");
    const installIndex = npmRun.indexOf("npm install");
    const cleanupIndex = npmRun.indexOf("rm -rf /tmp/npm-cache");
    const doctorIndex = npmRun.indexOf(
      "agent-browser doctor --offline --quick",
    );

    expect(npmRun).toContain("--cache /tmp/npm-cache");
    expect(installIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeGreaterThan(installIndex);
    expect(doctorIndex).toBeGreaterThan(cleanupIndex);
  });

  test("removes Go module and build caches after installing binaries", () => {
    const goRun = findRun(
      "github.com/projectdiscovery/interactsh/cmd/interactsh-client",
    );
    const lastInstallIndex = goRun.lastIndexOf("go install");
    const cleanIndex = goRun.indexOf("go clean -cache -modcache");
    const removeIndex = goRun.indexOf('rm -rf "$GOCACHE" "$GOPATH/pkg/mod"');

    expect(lastInstallIndex).toBeGreaterThan(-1);
    expect(cleanIndex).toBeGreaterThan(lastInstallIndex);
    expect(removeIndex).toBeGreaterThan(cleanIndex);
  });

  test("validates caches and important runtimes after cleanup", () => {
    const validationRun = findRun("=== Starting tool validation ===");

    for (const expected of [
      "test ! -e /home/user/.cache/pip",
      "test ! -e /tmp/npm-cache",
      'test ! -e "$GOCACHE"',
      'test ! -e "$GOPATH/pkg/mod"',
      "which interactsh-client",
      "which katana",
      "which cvemap",
      "which agent-browser",
      "which go",
      "which python3",
      "which node",
    ]) {
      expect(validationRun).toContain(expected);
    }
  });

  test("keeps the E2B Dockerfile build single-stage", () => {
    const template = readFileSync(
      resolve(process.cwd(), "e2b/template.ts"),
      "utf8",
    );

    expect(dockerfile.match(/^FROM\b/gm)).toHaveLength(1);
    expect(template).toContain(".fromDockerfile(");
    expect(template).toContain('resolve(__dirname, "../docker/Dockerfile")');
  });
});
