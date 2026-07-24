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
    const pipRuns = runInstructions.filter((run) =>
      run.includes("pip3 install"),
    );

    expect(pipRuns).not.toHaveLength(0);
    for (const run of pipRuns) {
      expect(run.match(/pip3 install/g)).toHaveLength(
        run.match(/--no-cache-dir/g)?.length ?? 0,
      );
    }
  });

  test("removes the temporary npm cache before validating agent-browser", () => {
    const npmRun = findRun("agent-browser@0.26.0");
    const cleanupIndex = npmRun.indexOf("rm -rf /tmp/npm-cache");
    const doctorIndex = npmRun.indexOf(
      "agent-browser doctor --offline --quick",
    );

    expect(npmRun).toContain("--cache /tmp/npm-cache");
    expect(cleanupIndex).toBeGreaterThan(-1);
    expect(doctorIndex).toBeGreaterThan(cleanupIndex);
  });

  test("removes Go module and build caches after installing binaries", () => {
    const goRun = findRun(
      "github.com/projectdiscovery/interactsh/cmd/interactsh-client",
    );

    expect(goRun).toContain("go clean -cache -modcache");
    expect(goRun).toContain('rm -rf "$GOCACHE" "$GOPATH/pkg/mod"');
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
  });
});
