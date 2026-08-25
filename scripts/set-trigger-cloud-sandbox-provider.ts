#!/usr/bin/env tsx

import { configure, envvars } from "@trigger.dev/sdk";
import {
  getTriggerCloudSandboxProviderConfig,
  setAndVerifyTriggerCloudSandboxProvider,
} from "./lib/trigger-cloud-sandbox-provider";

async function main() {
  const config = getTriggerCloudSandboxProviderConfig(process.env);
  configure({ secretKey: config.accessToken });
  await setAndVerifyTriggerCloudSandboxProvider({
    client: envvars,
    projectRef: config.projectRef,
    provider: config.provider,
  });
  console.log(
    `Trigger.dev production cloud sandbox provider verified as ${config.provider}.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
