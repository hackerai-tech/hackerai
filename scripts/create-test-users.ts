import { WorkOS } from "@workos-inc/node";
import * as dotenv from "dotenv";
import * as path from "path";
import chalk from "chalk";
import { getTestUsers } from "./test-users-config";

// Load environment variables from .env.e2e first, then .env.local
dotenv.config({ path: path.join(process.cwd(), ".env.e2e") });
dotenv.config({ path: path.join(process.cwd(), ".env.local") });

const workos = new WorkOS(process.env.WORKOS_API_KEY, {
  clientId: process.env.WORKOS_CLIENT_ID,
});

async function deleteTestUsers() {
  console.log(chalk.bold.red("\n🗑️  Deleting Test Users\n"));

  if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID) {
    console.log(
      chalk.red(
        "❌ Error: WORKOS_API_KEY and WORKOS_CLIENT_ID must be set in .env.local",
      ),
    );
    process.exit(1);
  }

  const testUsers = getTestUsers();
  for (const testUser of testUsers) {
    console.log(chalk.cyan(`\nDeleting ${testUser.email}...`));

    try {
      const usersList = await workos.userManagement.listUsers({
        email: testUser.email,
      });

      if (usersList.data.length > 0) {
        const user = usersList.data[0];
        await workos.userManagement.deleteUser(user.id);
        console.log(chalk.green(`  ✓ User deleted: ${user.id}`));
      } else {
        console.log(chalk.yellow(`  ⚠️  User not found`));
      }
    } catch (error: any) {
      console.log(
        chalk.red(`  ❌ Error deleting user: ${error.message || error}`),
      );
    }
  }

  console.log(chalk.bold.green("\n✨ Done!\n"));
}

async function resetPasswords() {
  console.log(chalk.bold.yellow("\n🔑 Resetting Test User Passwords\n"));

  if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID) {
    console.log(
      chalk.red(
        "❌ Error: WORKOS_API_KEY and WORKOS_CLIENT_ID must be set in .env.local",
      ),
    );
    process.exit(1);
  }

  const testUsers = getTestUsers();
  for (const testUser of testUsers) {
    console.log(chalk.cyan(`\nResetting password for ${testUser.email}...`));

    try {
      const usersList = await workos.userManagement.listUsers({
        email: testUser.email,
      });

      if (usersList.data.length > 0) {
        const user = usersList.data[0];
        await workos.userManagement.updateUser({
          userId: user.id,
          password: testUser.password,
        });
        console.log(chalk.green(`  ✓ Password reset for: ${user.id}`));
      } else {
        console.log(chalk.yellow(`  ⚠️  User not found`));
      }
    } catch (error: any) {
      console.log(
        chalk.red(`  ❌ Error resetting password: ${error.message || error}`),
      );
    }
  }

  console.log(chalk.bold.green("\n✨ Done!\n"));
}

async function createTestUsers() {
  console.log(chalk.bold.blue("\n🔧 Creating Test Users for E2E Tests\n"));

  if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID) {
    console.log(
      chalk.red(
        "❌ Error: WORKOS_API_KEY and WORKOS_CLIENT_ID must be set in .env.local",
      ),
    );
    process.exit(1);
  }

  console.log(chalk.cyan("📋 Using credentials from .env.e2e\n"));

  const createdUsers: Array<{ email: string; userId: string; tier: string }> =
    [];
  const existingUsers: Array<{ email: string; userId: string; tier: string }> =
    [];

  const testUsers = getTestUsers();
  for (const testUser of testUsers) {
    console.log(
      chalk.cyan(
        `\nProcessing ${testUser.tier.toUpperCase()} tier user: ${testUser.email}`,
      ),
    );

    try {
      // Check if user already exists
      console.log("  Checking if user exists...");
      const existingUsersList = await workos.userManagement.listUsers({
        email: testUser.email,
      });

      if (existingUsersList.data.length > 0) {
        const existingUser = existingUsersList.data[0];
        console.log(
          chalk.yellow(`  ⚠️  User already exists with ID: ${existingUser.id}`),
        );
        console.log(
          `  Email verified: ${existingUser.emailVerified ? chalk.green("Yes") : chalk.red("No")}`,
        );

        existingUsers.push({
          email: testUser.email,
          userId: existingUser.id,
          tier: testUser.tier,
        });

        // If email is not verified, we can try to update it
        if (!existingUser.emailVerified) {
          console.log(
            chalk.yellow(
              "  Attempting to verify email through WorkOS dashboard...",
            ),
          );
          console.log(
            chalk.yellow(
              `  Manual action required: Go to WorkOS dashboard and verify email for user ${existingUser.id}`,
            ),
          );
        }

        continue;
      }

      // Create new user
      console.log("  Creating new user...");
      const newUser = await workos.userManagement.createUser({
        email: testUser.email,
        password: testUser.password,
        emailVerified: true, // Attempt to mark email as verified
        firstName:
          testUser.tier.charAt(0).toUpperCase() + testUser.tier.slice(1),
        lastName: "Test User",
      });

      console.log(chalk.green(`  ✓ User created successfully!`));
      console.log(`  User ID: ${newUser.id}`);
      console.log(
        `  Email verified: ${newUser.emailVerified ? chalk.green("Yes") : chalk.red("No")}`,
      );

      createdUsers.push({
        email: testUser.email,
        userId: newUser.id,
        tier: testUser.tier,
      });
    } catch (error: any) {
      console.log(
        chalk.red(`  ❌ Error creating user: ${error.message || error}`),
      );

      if (error.code === "user_already_exists") {
        console.log(chalk.yellow("  User might exist, trying to fetch..."));
        try {
          const usersList = await workos.userManagement.listUsers({
            email: testUser.email,
          });
          if (usersList.data.length > 0) {
            existingUsers.push({
              email: testUser.email,
              userId: usersList.data[0].id,
              tier: testUser.tier,
            });
          }
        } catch (fetchError) {
          console.log(chalk.red("  Could not fetch existing user"));
        }
      }
    }
  }

  // Print summary
  console.log(chalk.bold.blue("\n📊 Summary\n"));

  if (createdUsers.length > 0) {
    console.log(chalk.green(`✓ Created ${createdUsers.length} new user(s):`));
    createdUsers.forEach((user) => {
      console.log(`  - ${user.email} (${user.tier}) - ID: ${user.userId}`);
    });
  }

  if (existingUsers.length > 0) {
    console.log(
      chalk.yellow(`\n⚠️  Found ${existingUsers.length} existing user(s):`),
    );
    existingUsers.forEach((user) => {
      console.log(`  - ${user.email} (${user.tier}) - ID: ${user.userId}`);
    });
  }

  // Print next steps
  console.log(chalk.bold.blue("\n📝 Next Steps\n"));

  const users = getTestUsers();
  console.log(
    "1. Ensure your " + chalk.bold(".env.e2e") + " file has these credentials:",
  );
  console.log();
  console.log(chalk.cyan(`   TEST_FREE_TIER_USER=${users[0].email}`));
  console.log(chalk.cyan(`   TEST_FREE_TIER_PASSWORD=${users[0].password}`));
  console.log();
  console.log(chalk.cyan(`   TEST_PRO_TIER_USER=${users[1].email}`));
  console.log(chalk.cyan(`   TEST_PRO_TIER_PASSWORD=${users[1].password}`));
  console.log();
  console.log(chalk.cyan(`   TEST_ULTRA_TIER_USER=${users[2].email}`));
  console.log(chalk.cyan(`   TEST_ULTRA_TIER_PASSWORD=${users[2].password}`));
  console.log();

  console.log("\n2. Run verification script to verify all emails:");
  console.log(chalk.cyan("   npx tsx scripts/verify-test-users.ts"));
  console.log("   Or use the combined command:");
  console.log(chalk.cyan("   pnpm test:e2e:setup"));

  console.log("\n3. For subscription tiers (Pro/Ultra), you may need to:");
  console.log("   a. Set up Stripe subscriptions manually, or");
  console.log("   b. Create organizations with proper entitlements in WorkOS");

  console.log(chalk.bold.green("\n✨ Done!\n"));
}

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0] || "create";

async function main() {
  switch (command) {
    case "delete":
      await deleteTestUsers();
      break;
    case "reset-passwords":
      await resetPasswords();
      break;
    case "create":
    default:
      await createTestUsers();
      break;
  }
}

main().catch((error) => {
  console.error(chalk.red("\n❌ Fatal error:"), error);
  process.exit(1);
});
