import { spawn } from "node:child_process";
import { promises as dns } from "node:dns";
import { tmpdir } from "node:os";
import { ProcessRunner } from "./process-runner";

const STEP_TIMEOUT_MS = 5_000;

export type CloudImagePrimeStep = {
  name: string;
  duration_ms: number;
};

export type CloudImagePrimeResult = {
  duration_ms: number;
  steps: CloudImagePrimeStep[];
};

export class CloudImagePrimeError extends Error {
  constructor(
    readonly step: string,
    readonly completedSteps: CloudImagePrimeStep[],
    cause: unknown,
  ) {
    super(`Cloud image priming failed at ${step}`, { cause });
    this.name = "CloudImagePrimeError";
  }
}

type PrimeDependencies = {
  primeRelay: () => Promise<void>;
  lookupDns?: () => Promise<void>;
  primePty?: () => Promise<void>;
  runCommand?: (executable: string, args: string[]) => Promise<void>;
};

async function runBoundedCommand(
  executable: string,
  args: string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: tmpdir(),
      env: process.env,
      stdio: "ignore",
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${executable} priming timed out`));
    }, STEP_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${executable} priming exited ${code}`));
    });
  });
}

async function primePty(): Promise<void> {
  const runner = new ProcessRunner();
  try {
    await new Promise<void>((resolve, reject) => {
      const sessionId = "image-validation";
      const timeout = setTimeout(() => {
        runner.stop(sessionId);
        reject(new Error("PTY priming timed out"));
      }, STEP_TIMEOUT_MS);
      runner.on("exit", (exitedSessionId, exitCode) => {
        if (exitedSessionId !== sessionId) return;
        clearTimeout(timeout);
        if (exitCode === 0) resolve();
        else reject(new Error(`PTY priming exited ${exitCode}`));
      });
      runner.on("error", (errorSessionId, error) => {
        if (errorSessionId !== sessionId) return;
        clearTimeout(timeout);
        reject(error);
      });
      runner.run(sessionId, "printf hackerai-image-prime", {
        cwd: tmpdir(),
        cols: 80,
        rows: 24,
      });
    });
  } finally {
    await runner.shutdown();
  }
}

export async function primeCloudImageWorkingSet(
  dependencies: PrimeDependencies,
): Promise<CloudImagePrimeResult> {
  const startedAt = performance.now();
  const completedSteps: CloudImagePrimeStep[] = [];
  const runStep = async (name: string, operation: () => Promise<void>) => {
    const stepStartedAt = performance.now();
    try {
      await operation();
      completedSteps.push({
        name,
        duration_ms: Math.round(performance.now() - stepStartedAt),
      });
    } catch (error) {
      throw new CloudImagePrimeError(name, completedSteps, error);
    }
  };

  await runStep("relay_protocol", dependencies.primeRelay);
  await runStep(
    "dns_lookup",
    dependencies.lookupDns ??
      (async () => {
        await dns.lookup("localhost");
      }),
  );
  await runStep("pty", dependencies.primePty ?? primePty);
  const runCommand = dependencies.runCommand ?? runBoundedCommand;
  await runStep("bash", () =>
    runCommand("/bin/bash", ["--noprofile", "--norc", "-c", ":"]),
  );
  await runStep("sudo", () => runCommand("/usr/bin/sudo", ["-n", "true"]));
  await runStep("nmap", () => runCommand("/usr/bin/nmap", ["--version"]));
  await runStep("naabu", () =>
    runCommand("/usr/local/bin/naabu", ["-version"]),
  );

  return {
    duration_ms: Math.round(performance.now() - startedAt),
    steps: completedSteps,
  };
}
