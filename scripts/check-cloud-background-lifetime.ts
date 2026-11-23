/**
 * Opt-in E2B check for cloud background processes (HAC-266). Not run in CI.
 *
 * Creates one disposable sandbox, starts a background process through the
 * application launcher, waits past the launcher's deadline, then checks the
 * inventory, log, cap and process-group stop. The sandbox is always killed.
 *
 *   E2B_API_KEY=... HACKERAI_CONFIRM_E2B_SANDBOX=1 \
 *     corepack pnpm exec tsx scripts/check-cloud-background-lifetime.ts
 *
 * Optional: E2B_TEMPLATE (defaults to "base"), BACKGROUND_CHECK_WAIT_SECONDS
 * (defaults to 45, above the 30-second launcher deadline).
 */
import { Sandbox } from "@e2b/code-interpreter";
import { MAX_CLOUD_BACKGROUND_PROCESSES } from "../lib/ai/tools/schemas";
import {
  listCloudBackgroundProcesses,
  startCloudBackgroundProcess,
} from "../lib/ai/tools/utils/cloud-background-processes";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

async function main() {
  if (!process.env.E2B_API_KEY || !process.env.HACKERAI_CONFIRM_E2B_SANDBOX) {
    throw new Error(
      "Set E2B_API_KEY and HACKERAI_CONFIRM_E2B_SANDBOX=1 to create a disposable sandbox.",
    );
  }
  const waitSeconds = Number(process.env.BACKGROUND_CHECK_WAIT_SECONDS ?? 45);
  const sandbox = await Sandbox.create(process.env.E2B_TEMPLATE ?? "base", {
    timeoutMs: (waitSeconds + 180) * 1000,
  });
  console.log(`Created disposable sandbox ${sandbox.sandboxId}`);
  try {
    const first = await startCloudBackgroundProcess(sandbox, {
      command: "while true; do echo tick; sleep 1; done",
      label: "tick loop",
    });
    if (first.kind !== "started") throw new Error("FAIL: first start capped");
    console.log(`Started ${first.process.id} (PID ${first.process.pid})`);

    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    const listed = await listCloudBackgroundProcesses(sandbox);
    check(
      listed.some((p) => p.id === first.process.id),
      `process is still running after ${waitSeconds}s`,
    );
    const ticks =
      // The launcher runs as root like other app commands; its registry is 0700.
      (
        await sandbox.commands.run(`grep -c tick ${first.process.logPath}`, {
          user: "root",
        })
      ).stdout.trim();
    check(
      Number(ticks) >= waitSeconds - 5,
      `log kept growing (${ticks} lines)`,
    );

    for (let i = 1; i < MAX_CLOUD_BACKGROUND_PROCESSES; i++) {
      const extra = await startCloudBackgroundProcess(sandbox, {
        command: "sleep 600",
        label: `filler ${i}`,
      });
      check(extra.kind === "started", `filler ${i} started under the cap`);
    }
    const capped = await startCloudBackgroundProcess(sandbox, {
      command: "sleep 600",
      label: "over the cap",
    });
    check(
      capped.kind === "cap_reached" &&
        capped.running.length === MAX_CLOUD_BACKGROUND_PROCESSES,
      "start beyond the cap is refused with the running list",
    );

    await sandbox.commands.run(`kill -- -${first.process.pid}`, {
      user: "root",
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const afterStop = await listCloudBackgroundProcesses(sandbox);
    check(
      !afterStop.some((p) => p.id === first.process.id),
      "process-group stop removes it from the inventory",
    );
  } finally {
    await sandbox.kill();
    console.log(`Killed disposable sandbox ${sandbox.sandboxId}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
