#!/usr/bin/env tsx

import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AWS_LAMBDA_MICROVM_ENABLED_REGIONS_ENV,
  buildAwsLambdaMicrovmReleaseManifest,
  parseAwsLambdaMicrovmEnabledRegions,
  parseRegionalReleaseOutput,
  serializeAwsLambdaMicrovmReleaseEnvironment,
} from "./lib/aws-microvm-release-manifest";

async function main() {
  const inputDirectory = process.env.AWS_LAMBDA_MICROVM_RELEASE_INPUT_DIR;
  const outputFile = process.env.AWS_LAMBDA_MICROVM_OUTPUT_FILE;
  const releaseId = process.env.GITHUB_SHA?.trim();
  if (!inputDirectory || !outputFile || !releaseId) {
    throw new Error(
      "AWS_LAMBDA_MICROVM_RELEASE_INPUT_DIR, AWS_LAMBDA_MICROVM_OUTPUT_FILE, and GITHUB_SHA are required",
    );
  }
  const directory = resolve(inputDirectory);
  const files = (await readdir(directory)).filter((file) =>
    file.endsWith(".env"),
  );
  const outputs = await Promise.all(
    files.map(async (file) =>
      parseRegionalReleaseOutput(
        await readFile(resolve(directory, file), "utf8"),
      ),
    ),
  );
  const manifest = buildAwsLambdaMicrovmReleaseManifest({
    releaseId,
    outputs,
    enabledRegions: parseAwsLambdaMicrovmEnabledRegions(
      process.env[AWS_LAMBDA_MICROVM_ENABLED_REGIONS_ENV],
    ),
  });
  await writeFile(
    resolve(outputFile),
    `${serializeAwsLambdaMicrovmReleaseEnvironment(manifest)}\n`,
    { mode: 0o600 },
  );
  console.log(
    `Built atomic AWS Lambda MicroVM release ${manifest.releaseId} for ${Object.keys(manifest.regions).join(", ")}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
