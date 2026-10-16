import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import { createRunTerminalCmd } from "./run-terminal-cmd";
import { authenticationCommand } from "./utils/authentication-program";

const privateFile = z
  .string()
  .max(4096)
  .regex(/^\/[^\x00-\x1f]*$/, "Use an absolute sandbox-local file path");

export const authenticationRequestSchema = z.object({
  url: z
    .string()
    .max(2048)
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }, "Use a known permitted HTTP identity endpoint without credentials, query or fragment"),
  credential_file: privateFile.describe(
    "An authorized credential file already in this sandbox, owned by the runtime user with mode 0600. Never read its values into the conversation or create it by pasting secrets into terminal arguments.",
  ),
  credential_format: z.enum(["cookie_header", "netscape", "browser_state"]),
  expectation_file: privateFile.describe(
    'A private JSON file for this account: {"origin":"https://app.example","identity_pointer":"/user/id","identity":"expected-account-id"}. Use a known identity endpoint, not an echo endpoint. Only file references enter the tool.',
  ),
});

/** Reuse terminal authorization, sandbox identity, billing and cancellation. */
export function createVerifyAuthentication(context: ToolContext) {
  const terminal = createRunTerminalCmd(context);
  return tool({
    description:
      "Diagnose cookie authentication before calling a session expired. Makes one bounded GET to a known permitted JSON identity endpoint using authorized sandbox-local files. Explicitly distinguishes Cookie-header text, Netscape jars and plaintext browser state. Checks cookie scope, actual client request attachment and expected identity; returns only diagnostic enums/counts. No redirects, response bodies, credential values, credential persistence or automatic login. A 401 does not prove expiry. Browser-state verification uses scoped cookies only; it does not replay local/session storage, SameSite browser context or encrypted managed checkpoints. For storage-dependent auth, use the authorized browser and verify its actual account UI. Requires existing python3 and requests in the selected sandbox; never install them automatically.",
    inputSchema: authenticationRequestSchema,
    execute: async (input, options) => {
      // Validate here too: programmatic callers must not bypass the schema.
      const request = authenticationRequestSchema.parse(input);
      return terminal.execute!(
        {
          command: authenticationCommand(request),
          brief: "Verify cookie attachment and expected account identity",
          is_background: false,
          interactive: false,
          timeout: 30,
        },
        options,
      );
    },
  });
}
