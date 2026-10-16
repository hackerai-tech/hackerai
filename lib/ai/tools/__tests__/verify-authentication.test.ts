import {
  authenticationRequestSchema,
  createVerifyAuthentication,
} from "../verify-authentication";
import { createRunTerminalCmd } from "../run-terminal-cmd";
import type { ToolContext } from "@/types";
import { resolveSubagentAllowedToolNames } from "../../subagents/profiles";

jest.mock("../run-terminal-cmd", () => ({ createRunTerminalCmd: jest.fn() }));
const request = {
  url: "https://app.example/me",
  credential_file: "/private/cookies",
  credential_format: "netscape" as const,
  expectation_file: "/private/alice.json",
};

test("forwards the same owner context, cancellation and call identity through the foreground terminal lifecycle", async () => {
  const context = {
    chatId: "child-chat",
    ptyScopeId: "child-scope",
  } as ToolContext;
  const execute = jest.fn(async () => ({
    result: { output: '{"outcome":"authenticated"}' },
  }));
  jest.mocked(createRunTerminalCmd).mockReturnValue({ execute } as never);
  const diagnostic = createVerifyAuthentication(context);
  const options = {
    toolCallId: "auth-1",
    messages: [],
    abortSignal: new AbortController().signal,
  };
  const output = await diagnostic.execute!(request, options);
  expect(createRunTerminalCmd).toHaveBeenCalledWith(context);
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      is_background: false,
      interactive: false,
      timeout: 30,
    }),
    options,
  );
  expect(output).toEqual({ result: { output: '{"outcome":"authenticated"}' } });
  expect(resolveSubagentAllowedToolNames("security_task")).toContain(
    "verify_authentication",
  );
  expect(resolveSubagentAllowedToolNames("security_validation")).toContain(
    "verify_authentication",
  );
});

test.each([
  { url: "https://user:secret@app.example/me" },
  { url: "https://app.example/me?token=secret" },
  { url: "file:///private/cookies" },
  { credential_file: "sid=secret" },
  { credential_file: "/private/cookies\ncat /secret" },
])(
  "rejects unsafe reference or endpoint input before command construction: %p",
  (override) => {
    expect(
      authenticationRequestSchema.safeParse({ ...request, ...override })
        .success,
    ).toBe(false);
  },
);
