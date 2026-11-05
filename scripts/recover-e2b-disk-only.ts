/**
 * Operator-only recovery. Reads the authorization record from stdin so no
 * customer identity or configuration is placed in shell arguments/history.
 * Run only after following docs/e2b-disk-recovery.md.
 */
import {
  DiskRecoveryError,
  recoverE2BDiskOnly,
  validateDiskRecoveryAuthorization,
} from "../lib/ai/tools/utils/e2b-disk-recovery";

async function main() {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > 16_384) throw new Error("Authorization record exceeds 16 KiB");
    chunks.push(buffer);
  }
  const auth = validateDiskRecoveryAuthorization(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  const result = await recoverE2BDiskOnly(auth);
  // Only bounded metadata and provider IDs. Never print file names or contents.
  process.stdout.write(JSON.stringify(result) + "\n");
}

void main().catch((error: unknown) => {
  if (error instanceof DiskRecoveryError) {
    process.stderr.write(
      JSON.stringify({
        status: "stopped",
        stage: error.stage,
        message: error.message,
        ...error.details,
      }) + "\n",
    );
  } else {
    process.stderr.write(
      JSON.stringify({
        status: "stopped",
        stage: "unknown",
        message: "Inspect the durable recovery fence and provider state",
      }) + "\n",
    );
  }
  process.exitCode = 1;
});
