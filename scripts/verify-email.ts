import { WorkOS } from "@workos-inc/node";
import * as dotenv from "dotenv";
import * as path from "path";
import chalk from "chalk";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID) {
  console.error(chalk.red("❌ Missing required environment variables: WORKOS_API_KEY and/or WORKOS_CLIENT_ID"));
  process.exit(1);
}

const workos = new WorkOS(process.env.WORKOS_API_KEY, {
  clientId: process.env.WORKOS_CLIENT_ID,
});

const targetEmail = process.argv[2];

if (!targetEmail) {
  console.error(chalk.red("❌ Usage: npx tsx scripts/verify-email.ts <email>"));
  process.exit(1);
}

async function verifyUserEmail(email: string) {
  console.log(chalk.bold.blue(`\n🔍 Looking for user: ${email}\n`));

  const users = await workos.userManagement.listUsers({ email });

  if (users.data.length === 0) {
    console.log(chalk.red("❌ User not found"));
    return;
  }

  const user = users.data[0];
  console.log(chalk.cyan(`Found user: ${user.id}`));
  console.log(`Email verified: ${user.emailVerified ? chalk.green("Yes") : chalk.red("No")}`);

  if (!user.emailVerified) {
    console.log(chalk.yellow("\n📧 Verifying email..."));
    const updated = await workos.userManagement.updateUser({
      userId: user.id,
      emailVerified: true,
    });
    console.log(chalk.green(`✓ Email verified: ${updated.emailVerified}`));
  } else {
    console.log(chalk.green("\n✓ Email already verified"));
  }

  console.log(chalk.bold.green("\n✨ Done!\n"));
}

verifyUserEmail(targetEmail).catch((error) => {
  console.error(chalk.red("\n❌ Error:"), error.message || error);
  process.exit(1);
});
