import { config } from "dotenv";
import { resolve } from "path";
import { Template, defaultBuildLogger } from "e2b";
import { template } from "./template";

config({ path: resolve(__dirname, "../.env.local") });

const EU_DOMAIN = "e2b-juliett.dev";

async function main() {
  const target = process.argv[2];
  if (target !== "dev" && target !== "prod") {
    throw new Error("Expected an E2B EU build target: dev or prod");
  }

  const apiKey = process.env.E2B_EU_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("E2B_EU_API_KEY is required to build the EU template");
  }

  const templateName =
    process.env.E2B_EU_TEMPLATE?.trim() ||
    (target === "dev"
      ? "terminal-agent-sandbox-dev"
      : "terminal-agent-sandbox");

  await Template.build(template, templateName, {
    apiKey,
    domain: process.env.E2B_EU_DOMAIN?.trim() || EU_DOMAIN,
    cpuCount: 4,
    memoryMB: 4096,
    onBuildLogs: defaultBuildLogger(),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
