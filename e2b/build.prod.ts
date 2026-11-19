import { config } from "dotenv";
import { resolve } from "path";
import { Template, defaultBuildLogger } from "e2b";
import { template } from "./template";
import { CURRENT_E2B_SANDBOX_VERSION } from "../lib/ai/tools/utils/e2b-sandbox-version";

config({ path: resolve(__dirname, "../.env.local") });

async function main() {
  await Template.build(template, "terminal-agent-sandbox", {
    tags: ["default", CURRENT_E2B_SANDBOX_VERSION],
    skipCache: true,
    cpuCount: 4,
    memoryMB: 4096,
    onBuildLogs: defaultBuildLogger(),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
