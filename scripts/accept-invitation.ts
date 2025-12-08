import { WorkOS } from "@workos-inc/node";
import * as dotenv from "dotenv";
import * as path from "path";
import chalk from "chalk";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID) {
  console.error(
    chalk.red(
      "❌ Missing required environment variables: WORKOS_API_KEY and/or WORKOS_CLIENT_ID",
    ),
  );
  process.exit(1);
}

const workos = new WorkOS(process.env.WORKOS_API_KEY, {
  clientId: process.env.WORKOS_CLIENT_ID,
});

const targetEmail = process.argv[2] || "test@hackerai.com";

async function acceptInvitationForUser(email: string) {
  console.log(
    chalk.bold.blue(`\n🔍 Looking for pending invitations for ${email}\n`),
  );

  // First, find the user
  const users = await workos.userManagement.listUsers({ email });

  if (users.data.length === 0) {
    console.log(chalk.red(`❌ User ${email} not found`));
    return;
  }

  const user = users.data[0];
  console.log(chalk.cyan(`Found user: ${user.id}`));

  // List all invitations and filter for this email
  const invitations = await workos.userManagement.listInvitations({});

  console.log(
    chalk.cyan(`\nTotal invitations found: ${invitations.data.length}`),
  );

  const pendingInvitations = invitations.data.filter(
    (inv) =>
      inv.email.toLowerCase() === email.toLowerCase() &&
      inv.state === "pending",
  );

  if (pendingInvitations.length === 0) {
    console.log(chalk.yellow(`⚠️  No pending invitations found for ${email}`));

    // Show all invitations for debugging
    const allForEmail = invitations.data.filter(
      (inv) => inv.email.toLowerCase() === email.toLowerCase(),
    );
    if (allForEmail.length > 0) {
      console.log(chalk.cyan(`\nAll invitations for ${email}:`));
      allForEmail.forEach((inv) => {
        console.log(
          `  - ID: ${inv.id}, State: ${inv.state}, Org: ${inv.organizationId}`,
        );
      });
    }
    return;
  }

  console.log(
    chalk.green(
      `\n✓ Found ${pendingInvitations.length} pending invitation(s):\n`,
    ),
  );

  for (const invitation of pendingInvitations) {
    console.log(chalk.cyan(`Invitation ID: ${invitation.id}`));
    console.log(`  Organization: ${invitation.organizationId}`);
    console.log(`  State: ${invitation.state}`);
    console.log(`  Created: ${invitation.createdAt}`);
    console.log(`  Expires: ${invitation.expiresAt}`);

    // Accept the invitation
    console.log(chalk.yellow(`\n  Accepting invitation...`));

    try {
      const accepted = await workos.userManagement.acceptInvitation(
        invitation.id,
      );
      console.log(chalk.green(`  ✓ Invitation accepted!`));
      console.log(`  New state: ${accepted.state}`);
    } catch (error: any) {
      console.log(chalk.red(`  ❌ Failed to accept: ${error.message}`));
    }
  }

  console.log(chalk.bold.green("\n✨ Done!\n"));
}

acceptInvitationForUser(targetEmail).catch((error) => {
  console.error(chalk.red("\n❌ Fatal error:"), error);
  process.exit(1);
});
