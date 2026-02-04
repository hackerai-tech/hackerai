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

async function getXaiApiKey(): Promise<string> {
  console.log(`\n${chalk.bold("Getting XAI API Key for Agent mode")}`);
  console.log("You can find your XAI API Key at: https://xai.com/api-keys");
  const key = await question("Enter your XAI API Key: ");

  if (key.startsWith("xai-")) {
    return key;
  }

  console.log(chalk.red("Invalid XAI API Key format"));
  console.log('XAI keys should start with "xai-"');

  return await getXaiApiKey();
}

async function getE2bApiKey(): Promise<string> {
  console.log(`\n${chalk.bold("Getting E2B API Key for Agent mode")}`);
  console.log(
    "E2B provides the sandbox environment required for agent mode to execute commands",
  );
  console.log("You can find your E2B API Key at: https://e2b.dev/dashboard");
  const key = await question("Enter your E2B API Key: ");

  if (key.startsWith("e2b_")) {
    return key;
  }

  console.log(chalk.red("Invalid E2B API Key format"));
  console.log('E2B keys should start with "e2b_"');

  return await getE2bApiKey();
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
    "Generated a secure random password for WorkOS cookie encryption",
  );
  return crypto.randomBytes(32).toString("base64");
}

function generateConvexServiceRoleKey(): string {
  console.log(`\n${chalk.bold("Generating CONVEX_SERVICE_ROLE_KEY")}`);
  console.log("Generated a secure random key for Convex service role");
  return crypto.randomBytes(32).toString("base64");
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

async function configureConvexDashboard(
  workOSClientId: string,
  convexServiceRoleKey: string,
) {
  console.log(`\n${chalk.bold("Configure Convex Dashboard")}`);
  console.log(
    "Please add the following environment variables to your Convex Dashboard:",
  );
  console.log("\n1. Go to: https://dashboard.convex.dev/");
  console.log("2. Select your project");
  console.log("3. Go to Settings → Environment Variables");
  console.log("4. Add the following required variables:\n");
  console.log(chalk.bold(`   WORKOS_CLIENT_ID=${workOSClientId}`));
  console.log(chalk.bold(`   CONVEX_SERVICE_ROLE_KEY=${convexServiceRoleKey}`));
  console.log("\nOptional variables (add later if using these features):");
  console.log("   - AWS_S3_* variables (if using S3 storage)");
  console.log("   - REDIS_URL (if using Redis for stream resumption)");
  console.log("   - STRIPE_* variables (if using Stripe payments)");
  console.log("   - LOCAL_SANDBOX_SESSION_SECRET (if using local sandbox)");
  return await question(
    "\nHit enter after you have added the required environment variables to Convex Dashboard",
  );
}

async function writeEnvFile(envVars: Record<string, string>) {
  console.log(`\n${chalk.bold("Writing environment variables to .env.local")}`);

  const envContent = `# =============================================================================
# AUTHENTICATION - WorkOS (Required)
# =============================================================================
# Sign up at: https://workos.com/
WORKOS_API_KEY=${envVars.WORKOS_API_KEY}

# ⚠️ IMPORTANT: Also add this to Convex Dashboard → Environment Variables
WORKOS_CLIENT_ID=${envVars.WORKOS_CLIENT_ID}

# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
WORKOS_COOKIE_PASSWORD=${envVars.WORKOS_COOKIE_PASSWORD}
NEXT_PUBLIC_WORKOS_REDIRECT_URI=${envVars.NEXT_PUBLIC_WORKOS_REDIRECT_URI}

# =============================================================================
# CONVEX DATABASE (Required)
# =============================================================================
# Run \`npx convex dev\` first to generate these values
CONVEX_DEPLOYMENT=${envVars.CONVEX_DEPLOYMENT || ""}
NEXT_PUBLIC_CONVEX_URL=${envVars.NEXT_PUBLIC_CONVEX_URL || ""}

# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# ⚠️ IMPORTANT: Also add this to Convex Dashboard → Environment Variables
CONVEX_SERVICE_ROLE_KEY=${envVars.CONVEX_SERVICE_ROLE_KEY}

# =============================================================================
# S3 FILE STORAGE (Optional - Feature Flag Controlled)
# =============================================================================
# AWS S3 credentials for file storage (only needed if S3 is enabled)
# Sign up at: https://aws.amazon.com/s3/
# ⚠️ IMPORTANT: If using S3, also add these to Convex Dashboard → Environment Variables
AWS_S3_ACCESS_KEY_ID=
AWS_S3_SECRET_ACCESS_KEY=
AWS_S3_REGION=us-east-1
AWS_S3_BUCKET_NAME=

# Optional S3 configuration (defaults shown, uncomment to override)
# S3_URL_LIFETIME_SECONDS=3600
# S3_URL_EXPIRATION_BUFFER_SECONDS=300

# =============================================================================
# AI PROVIDERS (Required)
# =============================================================================
# OpenRouter - Get key at: https://openrouter.ai/
OPENROUTER_API_KEY=${envVars.OPENROUTER_API_KEY}

# OpenAI - Get key at: https://platform.openai.com/
OPENAI_API_KEY=${envVars.OPENAI_API_KEY}

# XAI (Grok) - Get key at: https://x.ai/
XAI_API_KEY=${envVars.XAI_API_KEY}

# =============================================================================
# CODE EXECUTION - E2B (Required for Agent Mode)
# =============================================================================
# Sign up at: https://e2b.dev/
E2B_API_KEY=${envVars.E2B_API_KEY}
E2B_TEMPLATE=terminal-agent-sandbox

# =============================================================================
# LOCAL SANDBOX (Optional - Alternative to E2B)
# =============================================================================
# Secret for signing session tokens (HMAC-SHA256)
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# ⚠️ IMPORTANT: Set this in Convex Dashboard → Environment Variables
#               OR run: npx convex env set LOCAL_SANDBOX_SESSION_SECRET <value>
# LOCAL_SANDBOX_SESSION_SECRET=

# =============================================================================
# WEB SEARCH & SCRAPING (Optional)
# =============================================================================
# Web Search API - https://docs.perplexity.ai/guides/search-quickstart
# PERPLEXITY_API_KEY=

# Jina AI - URL content extraction: https://jina.ai/reader
# JINA_API_KEY=

# =============================================================================
# REDIS (Optional - for stream resumption)
# =============================================================================
# ⚠️ IMPORTANT: Also add this to Convex Dashboard → Environment Variables
# REDIS_URL=redis://localhost:6379

# =============================================================================
# RATE LIMITING (Optional - Upstash Redis)
# =============================================================================
# Sign up at: https://upstash.com/
# UPSTASH_REDIS_REST_URL=https://your-endpoint.upstash.io
# UPSTASH_REDIS_REST_TOKEN=

# =============================================================================
# FEATURE FLAGS (Optional)
# =============================================================================
# Cross-tab token sharing - coordinates auth token refresh across browser tabs
# to prevent WorkOS rate limits. Value is rollout percentage (0-100).
# NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING=0

# =============================================================================
# OBSERVABILITY (Optional - Axiom)
# =============================================================================
# Sign up at: https://axiom.co/
# AXIOM_TOKEN=xaat-your-token
# AXIOM_DATASET=your-dataset-name

# =============================================================================
# ANALYTICS (Optional - PostHog)
# =============================================================================
# Sign up at: https://posthog.com/
# NEXT_PUBLIC_POSTHOG_KEY=phc_
# NEXT_PUBLIC_POSTHOG_HOST=https://app.posthog.com
# NEXT_PUBLIC_POSTHOG_TRACK_FREE_USERS=true

# =============================================================================
# PAYMENTS (Optional - Stripe)
# =============================================================================
# Sign up at: https://stripe.com/
# ⚠️ IMPORTANT: If using Stripe, also add these to Convex Dashboard → Environment Variables
# STRIPE_API_KEY=sk_test_
# STRIPE_EXTRA_USAGE_WEBHOOK_SECRET=

# =============================================================================
# BASE URL (Required)
# =============================================================================
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
  const XAI_API_KEY = await getXaiApiKey();
  const E2B_API_KEY = await getE2bApiKey();

  // Get WorkOS configuration
  const WORKOS_API_KEY = await getWorkOSApiKey();
  const WORKOS_CLIENT_ID = await getWorkOSClientId();
  const NEXT_PUBLIC_BASE_URL = "http://localhost:3000";
  const NEXT_PUBLIC_WORKOS_REDIRECT_URI = `${NEXT_PUBLIC_BASE_URL}/callback`;
  const WORKOS_COOKIE_PASSWORD = generateWorkOSCookiePassword();
  const CONVEX_SERVICE_ROLE_KEY = generateConvexServiceRoleKey();

  // Configure WorkOS dashboard
  await configureWorkOSDashboard();

  // Setup Convex database
  const { NEXT_PUBLIC_CONVEX_URL, CONVEX_DEPLOYMENT } = await setupConvex();

  // Write the complete environment file
  await writeEnvFile({
    OPENROUTER_API_KEY,
    OPENAI_API_KEY,
    XAI_API_KEY,
    E2B_API_KEY,
    WORKOS_API_KEY,
    WORKOS_CLIENT_ID,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI,
    WORKOS_COOKIE_PASSWORD,
    NEXT_PUBLIC_CONVEX_URL,
    CONVEX_DEPLOYMENT,
    CONVEX_SERVICE_ROLE_KEY,
    NEXT_PUBLIC_BASE_URL,
  });

  // Configure Convex Dashboard
  await configureConvexDashboard(WORKOS_CLIENT_ID, CONVEX_SERVICE_ROLE_KEY);

  console.log(`\n${chalk.green.bold("🎉 Setup completed successfully!")}`);
  console.log("\nNext steps:");
  console.log(`1. Review your ${chalk.bold(".env.local")} file`);
  console.log(`2. Start the development server: ${chalk.bold("pnpm run dev")}`);
  console.log(`3. Visit: ${chalk.bold("http://localhost:3000")}`);
}

main().catch(console.error);
