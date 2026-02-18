import { WorkOS } from "@workos-inc/node";
import * as dotenv from "dotenv";
import * as path from "path";
import chalk from "chalk";
import { getTestUsers } from "./test-users-config";

// Load environment variables from .env.e2e and .env.local
dotenv.config({ path: path.join(process.cwd(), ".env.e2e") });
dotenv.config({ path: path.join(process.cwd(), ".env.local") });

const workos = new WorkOS(process.env.WORKOS_API_KEY, {
  clientId: process.env.WORKOS_CLIENT_ID,
});

async function verifyTestUsers() {
  console.log(chalk.bold.blue("\n✉️  Verifying Test User Emails\n"));

  if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID) {
    console.log(
      chalk.red(
        "❌ Error: WORKOS_API_KEY and WORKOS_CLIENT_ID must be set in .env.local",
      ),
    );
    process.exit(1);
  }

  const userIds: Array<{ email: string; id: string }> = [];

  const testEmails = getTestUsers().map((u) => u.email);

  // First, get all user IDs
  for (const email of testEmails) {
    try {
      const usersList = await workos.userManagement.listUsers({
        email,
      });

      if (usersList.data.length > 0) {
        userIds.push({ email, id: usersList.data[0].id });
      } else {
        console.log(
          chalk.yellow(
            `⚠️  User ${email} not found. Run create-test-users.ts first.`,
          ),
        );
      }
    } catch (error: any) {
      console.log(
        chalk.red(`❌ Error fetching user ${email}: ${error.message || error}`),
      );
    }
  }

  if (userIds.length === 0) {
    console.log(
      chalk.red("\n❌ No users found. Please run create-test-users.ts first."),
    );
    process.exit(1);
  }

  for (const user of userIds) {
    console.log(chalk.cyan(`\nVerifying ${user.email}...`));

    try {
      // Update user to set emailVerified to true
      const updatedUser = await workos.userManagement.updateUser({
        userId: user.id,
        emailVerified: true,
      });

      console.log(
        chalk.green(
          `  ✓ Email verification status: ${updatedUser.emailVerified ? "VERIFIED" : "NOT VERIFIED"}`,
        ),
      );
    } catch (error: any) {
      console.log(
        chalk.red(`  ❌ Error verifying user: ${error.message || error}`),
      );

      // Try to get current user status
      try {
        const currentUser = await workos.userManagement.getUser(user.id);
        console.log(
          `  Current status: ${currentUser.emailVerified ? chalk.green("VERIFIED") : chalk.red("NOT VERIFIED")}`,
        );
      } catch (fetchError) {
        console.log(chalk.red("  Could not fetch user status"));
      }
    }
  }

  console.log(chalk.bold.green("\n✨ Email verification complete!\n"));

  // Verify all users
  console.log(chalk.bold.blue("📊 Final Status Check\n"));

  for (const user of userIds) {
    try {
      const currentUser = await workos.userManagement.getUser(user.id);
      const status = currentUser.emailVerified
        ? chalk.green("✓ VERIFIED")
        : chalk.red("✗ NOT VERIFIED");
      console.log(`  ${user.email}: ${status}`);
    } catch (error) {
      console.log(`  ${user.email}: ${chalk.red("✗ ERROR")}`);
    }
  }

  console.log();
}

verifyTestUsers().catch((error) => {
  console.error(chalk.red("\n❌ Fatal error:"), error);
  process.exit(1);
});
