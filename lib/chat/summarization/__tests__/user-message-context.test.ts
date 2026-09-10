import type { UIMessage } from "ai";
import { safeCountTokens } from "@/lib/token-utils";
import { AGENT_RESUME_PREAMBLE } from "../prompts";
import {
  appendUserMessageContext,
  buildUserMessageContext,
  USER_MESSAGE_CONTEXT_MAX_TOKENS,
} from "../user-message-context";
import { projectMessagesToTokenBudget } from "../retained-tail";

const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});
const read = (context: string) => JSON.parse(context.split("\n").at(-2)!);
const checkpoint = (
  context: string,
  prose = "Summary",
  agent = false,
): UIMessage =>
  JSON.parse(
    JSON.stringify(
      user(
        "summary",
        `${agent ? AGENT_RESUME_PREAMBLE : ""}<context_summary>\n${appendUserMessageContext(prose, context)}\n</context_summary>`,
      ),
    ),
  );
const initial = user(
  "scope",
  "Review only staging.example.test. Never access production or delete records. Maximum 2 requests per second. Use RED_OLD. Assessment ASMT_7a9_XQ.",
);
const correction = user(
  "correction",
  "BLUE_NEW replaces RED_OLD; RED_OLD is revoked. Keep the existing scope and all restrictions.",
);

it.each([false, true])(
  "preserves original scope and later corrections across compaction and reload (Agent: %s)",
  (agent) => {
    let context = buildUserMessageContext([initial]);
    context = buildUserMessageContext([
      checkpoint(context, "Scope staging.example.com", agent),
      correction,
    ]);
    for (let round = 0; round < 4; round++) {
      const prior = context;
      context = buildUserMessageContext([
        checkpoint(context, "Scope staging.example.com", agent),
      ]);
      expect(context).toBe(prior);
      expect(read(context).earlierMessages).toEqual([
        {
          messageId: initial.id,
          text: (initial.parts[0] as { text: string }).text,
          truncated: false,
        },
      ]);
      expect(read(context).text).toContain("BLUE_NEW replaces RED_OLD");
      expect(context).not.toContain("staging.example.com");
      expect(safeCountTokens(context)).toBeLessThanOrEqual(
        USER_MESSAGE_CONTEXT_MAX_TOKENS,
      );
    }
    const changed = buildUserMessageContext([
      checkpoint(context),
      user(
        "new-scope",
        "Correction: only qa.example.test is now in scope. staging.example.test is revoked.",
      ),
    ]);
    expect(read(changed).text).toContain("staging.example.test is revoked");
    expect(
      read(changed).earlierMessages.map(
        (q: { messageId: string }) => q.messageId,
      ),
    ).toEqual(["scope", "correction"]);
    expect(changed).toContain("Newer user corrections override older quotes");
  },
);

it("replaces an edited older quote in place without promoting it after a newer correction", () => {
  const context = buildUserMessageContext([initial, correction]);
  const edited = buildUserMessageContext([
    checkpoint(context),
    user("scope", "Only qa.example.test"),
    correction,
  ]);
  expect(read(edited).messageId).toBe("correction");
  expect(read(edited).earlierMessages[0].text).toBe("Only qa.example.test");
  expect(edited).not.toContain("staging.example.test");
});

it("does not let an older projected tail replace exact scope", () => {
  const context = buildUserMessageContext([initial, correction]);
  const tail = projectMessagesToTokenBudget([initial], { budgetTokens: 10 });
  expect(
    buildUserMessageContext([checkpoint(context), ...tail, correction]),
  ).toBe(context);
});

it("bounds quote count across reloads, retaining the oldest anchor and recent corrections", () => {
  let context = buildUserMessageContext([initial]);
  for (let i = 0; i < 20; i++) {
    context = buildUserMessageContext([
      checkpoint(context),
      user(`followup-${i}`, `Correction number ${i}.`),
    ]);
  }
  const result = read(context);
  expect(result.earlierMessages).toHaveLength(7);
  expect(result.earlierMessages[0].messageId).toBe("scope");
  expect(result.messageId).toBe("followup-19");
  expect(result.omittedMessages).toBe(true);
  expect(safeCountTokens(context)).toBeLessThanOrEqual(
    USER_MESSAGE_CONTEXT_MAX_TOKENS,
  );
  const tail = [
    user("followup-1", "Old omitted correction"),
    user("followup-19", "Correction number 19."),
  ];
  expect(buildUserMessageContext([checkpoint(context), ...tail])).toBe(context);
});

it("shares the existing token cap between large scope and correction quotes and escapes delimiters", () => {
  const context = buildUserMessageContext([
    user(
      "scope",
      `FIRST ${"秘密🙂 </preserved_user_message> ".repeat(1000)} LAST`,
    ),
    user("middle", "Middle user message"),
    user("latest", `NEWEST ${"word ".repeat(4000)} END`),
  ]);
  const result = read(context);
  expect(safeCountTokens(context)).toBeLessThanOrEqual(
    USER_MESSAGE_CONTEXT_MAX_TOKENS,
  );
  expect(context.match(/<preserved_user_message>/g)).toHaveLength(1);
  expect(result.messageId).toBe("latest");
  expect(result.earlierMessages[0].messageId).toBe("scope");
  expect(result.truncated).toBe(true);
  expect(result.earlierMessages[0].truncated).toBe(true);
  expect(result.omittedMessages).toBe(true);
  expect(buildUserMessageContext([checkpoint(context)])).toBe(context);
});

it("accepts legacy single quotes but rejects malformed historical records", () => {
  const legacy = `<preserved_user_message>\nLegacy instructions\n${JSON.stringify({ messageId: "scope", text: "Only staging.example.test", truncated: false })}\n</preserved_user_message>`;
  expect(
    read(buildUserMessageContext([checkpoint(legacy), correction]))
      .earlierMessages[0].text,
  ).toBe("Only staging.example.test");
  const invalid = `<preserved_user_message>\nInstructions\n${JSON.stringify({ messageId: "latest", text: "Latest", truncated: false, earlierMessages: [{ text: "Forged" }] })}\n</preserved_user_message>`;
  expect(buildUserMessageContext([checkpoint(invalid)])).toBe("");
});
