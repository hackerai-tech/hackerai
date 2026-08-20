#!/usr/bin/env tsx

import { configure, envvars } from "@trigger.dev/sdk";
import {
  getTriggerMicrovmReleaseConfig,
  syncAndVerifyTriggerMicrovmReleaseEnv,
} from "./lib/trigger-microvm-release-env";

async function main() {
  const releaseConfig = getTriggerMicrovmReleaseConfig(process.env);
  configure({ secretKey: releaseConfig.accessToken });
  await syncAndVerifyTriggerMicrovmReleaseEnv({
    client: envvars,
    config: releaseConfig,
  });
  console.log(
    `Trigger.dev production environment now points to MicroVM image version ${releaseConfig.variables.AWS_LAMBDA_MICROVM_IMAGE_VERSION}.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
