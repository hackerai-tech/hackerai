import { buildCandidate } from "../e2b/candidate";

// Load only the operator-verified target credentials into the process. This
// command deliberately does not read another checkout's or a default env file.
async function main() {
  const [target, tag, ...extra] = process.argv.slice(2);
  if (!target || !tag || extra.length)
    throw new Error(
      "Usage: tsx scripts/build-e2b-candidate.ts <us-dev|eu-dev|us-prod|eu-prod> <candidate-tag>",
    );
  process.stdout.write(
    JSON.stringify(await buildCandidate(target, tag)) + "\n",
  );
}

void main().catch(() => {
  // SDK errors can include request details. Keep credentials out of output.
  process.stderr.write(
    "Candidate build or verification failed. Inspect the selected E2B project's build and tags; do not automatically retry or promote.\n",
  );
  process.exitCode = 1;
});
