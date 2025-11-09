import { config } from "dotenv";
import { resolve } from "path";
import { Template, defaultBuildLogger } from "e2b";
import { template } from "./template";

config({ path: resolve(__dirname, "../.env.local") });

async function main() {
  await Template.build(template, {
    alias: "terminal-agent-sandbox",
    cpuCount: 2,
    memoryMB: 1024,
    onBuildLogs: defaultBuildLogger(),
  });
}

main().catch(console.error);
