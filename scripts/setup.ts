import readline from "node:readline";
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import crypto from "node:crypto";
import path from "node:path";
import chalk from "chalk";

const execAsync = promisify(exec);

function question(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    }),
  );
}

async function getOpenRouterApiKey(): Promise<string> {
  console.log(`\n${chalk.bold("Getting OpenRouter API Key")}`);
  console.log(
    "You can find your OpenRouter API Key at: https://openrouter.ai/keys",
  );
  const key = await question("Enter your OpenRouter API Key: ");

  if (key.startsWith("sk-")) {
    return key;
  }

  console.log(chalk.red("Please enter a valid OpenRouter API Key"));
  console.log('OpenRouter keys should start with "sk-"');

  return await getOpenRouterApiKey();
}

async function getOpenAiApiKey(): Promise<string> {
  console.log(`\n${chalk.bold("Getting OpenAI API Key")}`);
  console.log(
    "You can find your OpenAI API Key at: https://platform.openai.com/api-keys",
  );
  const key = await question("Enter your OpenAI API Key: ");

  if (key.startsWith("sk-")) {
    return key;
  }

  console.log(chalk.red("Invalid OpenAI API Key format"));
  console.log('OpenAI keys should start with "sk-"');

  return await getOpenAiApiKey();
}

async function getWorkOSApiKey(): Promise<string> {
  console.log(`\n${chalk.bold("Getting WorkOS API Key")}`);
  console.log(
    'You can find your WorkOS API Key in the dashboard under the "Quick start" section: https://dashboard.workos.com/get-started',
  );

  const key = await question("Enter your WorkOS API Key: ");

  if (key.startsWith("sk_")) {
    return key;
  }

  console.log(chalk.red("Invalid WorkOS API Key format"));
  console.log('WorkOS keys should start with "sk_"');

  return await getWorkOSApiKey();
}

async function getWorkOSClientId(): Promise<string> {
  console.log(`\n${chalk.bold("Getting WorkOS Client ID")}`);
  console.log(
    'You can find your WorkOS Client ID in the dashboard under the "Quick start" section: https://dashboard.workos.com/get-started',
  );
  return await question("Enter your WorkOS Client ID: ");
}

function generateWorkOSCookiePassword(): string {
  console.log(`\n${chalk.bold("Generating WORKOS_COOKIE_PASSWORD")}`);
  console.log(
    "Generated a secure 64-character random password for WorkOS cookie encryption",
  );
  return crypto.randomBytes(32).toString("hex");
}

async function configureWorkOSDashboard() {
  console.log(`\n${chalk.bold("Configure WorkOS Dashboard")}`);
  console.log("Please complete the following steps in your WorkOS dashboard:");
  console.log(
    '1. Set redirect URI to: http://localhost:3000/callback (in "Redirects" section)',
  );
  console.log('2. Create an "Admin" role (in "Roles" section)');
  console.log("\nVisit: https://dashboard.workos.com/");
  return await question(
    "Hit enter after you have configured the WorkOS dashboard",
  );
}

async function writeEnvFile(envVars: Record<string, string>) {
  console.log(`\n${chalk.bold("Writing environment variables to .env.local")}`);

  const envContent = `# =============================================================================
# CONVEX DATABASE & AUTHENTICATION (Required)
# =============================================================================

# Convex deployment configuration
CONVEX_DEPLOYMENT=${envVars.CONVEX_DEPLOYMENT || ""}
NEXT_PUBLIC_CONVEX_URL=${envVars.NEXT_PUBLIC_CONVEX_URL || ""}

# WorkOS Authentication (Required for user management and conversation persistence)
WORKOS_API_KEY=${envVars.WORKOS_API_KEY}
WORKOS_CLIENT_ID=${envVars.WORKOS_CLIENT_ID}
# Generated secure password (64 characters)
WORKOS_COOKIE_PASSWORD=${envVars.WORKOS_COOKIE_PASSWORD}
NEXT_PUBLIC_WORKOS_REDIRECT_URI=${envVars.NEXT_PUBLIC_WORKOS_REDIRECT_URI}

# =============================================================================
# API CONFIGURATION (Required)
# =============================================================================

OPENROUTER_API_KEY=${envVars.OPENROUTER_API_KEY}
OPENAI_API_KEY=${envVars.OPENAI_API_KEY}

# =============================================================================
# OPTIONAL CONFIGURATIONS
# =============================================================================

# Web Search API Key (Optional - enables web search functionality)
# EXA_API_KEY=your_exa_api_key_here

# Terminal execution mode: "local" (default) or "sandbox"
# TERMINAL_EXECUTION_MODE=local
# E2B_API_KEY=your_e2b_api_key_here

# AI Model Configuration
# NEXT_PUBLIC_AGENT_MODEL=
# NEXT_PUBLIC_VISION_MODEL=
# NEXT_PUBLIC_TITLE_MODEL=

# Rate Limiting (Upstash Redis)
# UPSTASH_REDIS_REST_URL="https://your-redis-url.upstash.io"
# UPSTASH_REDIS_REST_TOKEN="your-redis-token"

# Analytics (PostHog)
# NEXT_PUBLIC_POSTHOG_KEY="phc_your_project_key_here"
# NEXT_PUBLIC_POSTHOG_HOST="https://app.posthog.com"

# Stripe (Optional)
# STRIPE_API_KEY=
NEXT_PUBLIC_BASE_URL=${envVars.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}
`;

  await fs.writeFile(path.join(process.cwd(), ".env.local"), envContent);
  console.log(
    chalk.green("✓ .env.local file created with all necessary variables"),
  );
}

async function setupConvex(): Promise<{
  NEXT_PUBLIC_CONVEX_URL: string;
  CONVEX_DEPLOYMENT: string;
}> {
  console.log(`\n${chalk.bold("Setting up Convex Database")}`);
  console.log(
    "Convex provides the real-time database and authentication backend",
  );

  console.log(`\nFirst, login to Convex: ${chalk.bold("npx convex login")}`);
  await question("Hit enter after you have logged into Convex");

  const projectName = await question(
    "\nEnter a name for your new Convex project: ",
  );
  const safeProject = projectName.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(safeProject)) {
    console.log(chalk.red("Project name must match /^[a-zA-Z0-9_-]+$/."));
    return await setupConvex();
  }

  try {
    console.log("Creating new Convex project (this may take a few moments)...");
    await execAsync(
      `npx convex dev --once --configure=new --project=${safeProject}`,
    );
    console.log(chalk.green("✓ Convex project created successfully"));

    // Read Convex variables from the generated .env.local file
    try {
      const envContent = await fs.readFile(
        path.join(process.cwd(), ".env.local"),
        "utf8",
      );
      const convexUrlMatch = envContent.match(/^NEXT_PUBLIC_CONVEX_URL=(.*)$/m);
      const deploymentMatch = envContent.match(/^CONVEX_DEPLOYMENT=(.*)$/m);
      return {
        NEXT_PUBLIC_CONVEX_URL: convexUrlMatch?.[1] || "",
        CONVEX_DEPLOYMENT: deploymentMatch?.[1] || "",
      };
    } catch (error) {
      console.log(
        chalk.yellow("⚠️  Could not read Convex env from generated file"),
      );
      return { NEXT_PUBLIC_CONVEX_URL: "", CONVEX_DEPLOYMENT: "" };
    }
  } catch (error) {
    console.log(chalk.red("✗ Failed to create Convex project"));
    console.log("Please check your internet connection and try again");
    console.log(error);
    process.exit(1);
  }
}

async function main() {
  console.log(chalk.bold.blue("🚀 HackerAI Setup Script"));
  console.log(
    "This script will help you configure all the necessary environment variables\n",
  );

  // Get required API keys
  const OPENROUTER_API_KEY = await getOpenRouterApiKey();
  const OPENAI_API_KEY = await getOpenAiApiKey();

  // Get WorkOS configuration
  const WORKOS_API_KEY = await getWorkOSApiKey();
  const WORKOS_CLIENT_ID = await getWorkOSClientId();
  const NEXT_PUBLIC_BASE_URL = "http://localhost:3000";
  const NEXT_PUBLIC_WORKOS_REDIRECT_URI = `${NEXT_PUBLIC_BASE_URL}/callback`;
  const WORKOS_COOKIE_PASSWORD = generateWorkOSCookiePassword();

  // Configure WorkOS dashboard
  await configureWorkOSDashboard();

  // Setup Convex database
  const { NEXT_PUBLIC_CONVEX_URL, CONVEX_DEPLOYMENT } = await setupConvex();

  // Write the complete environment file
  await writeEnvFile({
    OPENROUTER_API_KEY,
    OPENAI_API_KEY,
    WORKOS_API_KEY,
    WORKOS_CLIENT_ID,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI,
    WORKOS_COOKIE_PASSWORD,
    NEXT_PUBLIC_CONVEX_URL,
    CONVEX_DEPLOYMENT,
    NEXT_PUBLIC_BASE_URL,
  });

  console.log(`\n${chalk.green.bold("🎉 Setup completed successfully!")}`);
  console.log("\nNext steps:");
  console.log(`1. Review your ${chalk.bold(".env.local")} file`);
  console.log(`2. Start the development server: ${chalk.bold("pnpm run dev")}`);
  console.log(`3. Visit: ${chalk.bold("http://localhost:3000")}`);
}

main().catch(console.error);
