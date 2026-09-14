import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse } from "dotenv";
import { Sandbox } from "@e2b/code-interpreter";
import {
  emptyWorkspaceProbeCommand,
  parseEmptyWorkspaceFingerprint,
} from "../lib/ai/tools/utils/empty-workspace-probe";

/** Capture only from a NEW disposable template instance, never a user sandbox.
 * The operator must verify the selected file's E2B account/environment first. */
async function main() {
  const { values } = parseArgs({
    options: {
      "env-file": { type: "string" },
      "template-id": { type: "string" },
    },
    strict: true,
  });
  if (!values["env-file"] || !values["template-id"]) {
    throw new Error("usage");
  }
  const config = parse(readFileSync(values["env-file"]));
  if (!config.E2B_API_KEY?.trim()) throw new Error("credentials");
  const connection = {
    apiKey: config.E2B_API_KEY.trim(),
    domain: "e2b.app",
    requestTimeoutMs: 10000,
  };
  const sandbox = await Sandbox.create(values["template-id"], {
    ...connection,
    secure: true,
    timeoutMs: 120000,
    metadata: { purpose: "hackerai-empty-workspace-baseline" },
  });
  let baseline;
  try {
    const info = await sandbox.getInfo();
    const capture = async () => {
      const result = await sandbox.commands.run(emptyWorkspaceProbeCommand, {
        user: "root",
        cwd: "/",
        timeoutMs: 50000,
      });
      return parseEmptyWorkspaceFingerprint(result.stdout);
    };
    const first = await capture();
    const second = await capture();
    if (!first || !second || first.digest !== second.digest)
      throw new Error("unstable");
    baseline = {
      version: 1,
      templateId: info.templateId,
      digest: first.digest,
    };
  } finally {
    // Only this disposable ID is ever killed. A cleanup failure fails the tool
    // and is reported with the retained disposable ID, never provider details.
    try {
      await sandbox.kill();
    } catch {
      process.stderr.write(
        `Disposable baseline sandbox cleanup failed: ${sandbox.sandboxId}\n`,
      );
      throw new Error("cleanup");
    }
  }
  process.stdout.write(JSON.stringify([baseline]) + "\n");
}

void main().catch(() => {
  process.stderr.write(
    "Baseline capture failed. Verify the selected E2B environment and template. Unknown or unstable filesystems are not eligible. Usage: pnpm exec tsx scripts/miosa-empty-baseline.ts --env-file /verified/environment --template-id TEMPLATE\n",
  );
  process.exitCode = 1;
});
