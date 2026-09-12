import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse } from "dotenv";
import { WorkOS } from "@workos-inc/node";
import {
  matchesMiosaUserReference,
  miosaExternalUserId,
  miosaUserReference,
} from "../lib/ai/tools/utils/miosa-identity";

const usage = `Read-only account/sandbox lookup (prints personal account data locally).
pnpm exec tsx scripts/miosa-lookup.ts --env-file <verified-environment-file> --email <email>
pnpm exec tsx scripts/miosa-lookup.ts --env-file <verified-environment-file> --reference <reference-or-existing-name>
pnpm exec tsx scripts/miosa-lookup.ts --env-file <verified-environment-file> --sandbox-id <id>
The selected file must contain WORKOS_API_KEY, WORKOS_CLIENT_ID and MIOSA_API_KEY
for the same intended environment. No values are inherited from other env files.`;

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      "env-file": { type: "string" },
      email: { type: "string" },
      reference: { type: "string" },
      "sandbox-id": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (
    !values["env-file"] ||
    [values.email, values.reference, values["sandbox-id"]].filter(Boolean)
      .length !== 1
  ) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  // Explicit isolated configuration: do not merge Preview/Production credentials.
  const config = parse(readFileSync(values["env-file"]));
  if (
    !config.WORKOS_API_KEY ||
    !config.WORKOS_CLIENT_ID ||
    !config.MIOSA_API_KEY
  ) {
    throw new Error("configuration");
  }
  const workos = new WorkOS(config.WORKOS_API_KEY, {
    clientId: config.WORKOS_CLIENT_ID,
  });
  const { Miosa } = await import("@miosa/sdk");
  const miosa = new Miosa({
    apiKey: config.MIOSA_API_KEY,
    ...(config.MIOSA_BASE_URL ? { baseUrl: config.MIOSA_BASE_URL } : {}),
  });
  const sandbox = values["sandbox-id"]
    ? await miosa.sandboxes.get(values["sandbox-id"])
    : undefined;
  // Use the full immutable identity for reverse resolution whenever available.
  const reference = sandbox
    ? sandbox.data.external_user_id || sandbox.data.name
    : values.reference;
  if (
    !values.email &&
    (!reference ||
      !/^hackerai-(?:user-[a-f0-9]{12}|[a-f0-9]{24}(?:-v2)?)$/.test(reference))
  ) {
    throw new Error("identity");
  }
  const matches = [];
  let after: string | undefined;
  do {
    const page = await workos.userManagement.listUsers({
      ...(values.email ? { email: values.email } : {}),
      limit: 100,
      ...(after ? { after } : {}),
    });
    for (const user of page.data) {
      if (values.email || matchesMiosaUserReference(user.id, reference!))
        matches.push(user);
    }
    after = page.listMetadata.after ?? undefined;
  } while (after);
  // A shortened reference is not guaranteed unique. Never select its first match.
  if (matches.length !== 1) {
    console.log(
      JSON.stringify({
        matchCount: matches.length,
        result: matches.length
          ? "ambiguous_reference_use_full_workspace_name"
          : "no_account_in_selected_environment",
      }),
    );
    process.exitCode = 1;
    return;
  }
  const user = matches[0];
  const externalUserId = miosaExternalUserId(user.id);
  const sandboxes = sandbox
    ? [sandbox]
    : await miosa.sandboxes.list({ externalUserId });
  console.log(
    JSON.stringify(
      {
        user: {
          id: user.id,
          email: user.email,
          name: [user.firstName, user.lastName].filter(Boolean).join(" "),
        },
        userReference: miosaUserReference(user.id),
        externalUserId,
        sandboxes: sandboxes.map(({ data }) => ({
          id: data.id,
          name: data.name,
          state: data.state,
          template: data.template_id,
          environment: data.metadata?.environment ?? "unknown",
          storedUserReference: data.metadata?.userReference ?? null,
        })),
      },
      null,
      2,
    ),
  );
}

if (require.main === module)
  main().catch(() => {
    // Provider exceptions may contain credentials, headers or personal data.
    console.error(
      "Lookup failed. Verify the selected environment file, credentials, reference and service availability. No sandbox was changed.",
    );
    process.exitCode = 1;
  });
