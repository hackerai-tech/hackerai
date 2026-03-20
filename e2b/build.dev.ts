import { config } from "dotenv";
import { resolve } from "path";
import { Template, defaultBuildLogger } from "e2b";
import { template } from "./template";

config({ path: resolve(__dirname, "../.env.local") });

async function main() {
  await Template.build(template, "terminal-agent-sandbox-dev", {
    cpuCount: 4,
    memoryMB: 2048,
    onBuildLogs: defaultBuildLogger(),
  });
}

main().catch(console.error);
