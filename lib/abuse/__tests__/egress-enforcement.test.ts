/** @jest-environment node */
import { prepareReview, type ReviewItems } from "../egress-review";
import {
  buildBlockNotice,
  buildIntentConfirmationPrompt,
  decideEnforcement,
  keepActiveReason,
  type EgressIntentConfirmation,
} from "../egress-enforcement";

// Synthetic, benign placeholders: documentation addresses and invented names.
const TARGET = "placeholder-target.net";
const OTHER = "203.0.113.10";
const BURST = { start: 1_000_000, end: 1_060_000 };
const complete = {
  rawReads: 3,
  historyTruncated: false,
  userMessagesOmitted: 0,
  commandsOmitted: 0,
  incompleteToolCalls: 0,
  runActive: false,
};
const evidence = (messages: string[], commands: string[]): ReviewItems => ({
  userMessages: messages.map((text, i) => ({
    messageId: `m${i}`,
    text,
    truncated: false,
  })),
  commands: commands.map((text, i) => ({
    messageId: "a1",
    toolCallId: `c${i}`,
    tool: "run_terminal_cmd" as const,
    text,
    truncated: false,
  })),
  coverage: complete,
});
const concerning = {
  outcome: "authorization_request" as const,
  reason: "concerning_unauthorized" as const,
  activity: "denial_of_service" as const,
  commands: [0],
  messages: [],
};
const confirmation = (
  overrides: Partial<EgressIntentConfirmation> = {},
): EgressIntentConfirmation => ({
  harmfulIntent: "explicit",
  intentKind: "service_disruption",
  voice: "own_request",
  authorizationClaim: "none_stated",
  messageIndices: [1],
  commandIndices: [1],
  // The first placeholder assigned: the target named in the message.
  targetIds: [1],
  ...overrides,
});
const prepared = prepareReview(
  evidence(
    [`synthetic statement of intent against ${TARGET}`],
    [`synthetic-tool --target ${TARGET}`, `synthetic-tool --target ${OTHER}`],
  ),
  BURST,
);

describe("decideEnforcement", () => {
  it("blocks only a corroborated, explicit, first-person intent on the cited target", () => {
    expect(prepared.messages[0].text).toContain("[T1:public-host]");
    expect(decideEnforcement(confirmation(), prepared, concerning)).toEqual({
      block: true,
      intentKind: "service_disruption",
      commands: [0],
      messages: [0],
    });
  });

  it.each<[string, Partial<EgressIntentConfirmation>]>([
    [
      "authorization is claimed",
      { authorizationClaim: "claims_authorization" },
    ],
    ["authorization is unclear", { authorizationClaim: "unclear" }],
    ["intent is only implied", { harmfulIntent: "implied" }],
    ["intent is unclear", { harmfulIntent: "unclear" }],
    ["the text is quoted or pasted", { voice: "quoted_or_pasted" }],
    ["the text is educational", { voice: "hypothetical_or_educational" }],
    ["the harm kind is unspecific", { intentKind: "other" }],
    ["no message states it", { messageIndices: [] }],
    ["no command is cited", { commandIndices: [] }],
    ["no target is cited", { targetIds: [] }],
    // A scope mismatch alone: the command's target is not the stated one.
    ["the cited target was never stated", { targetIds: [2] }],
    ["the cited command acted on another target", { commandIndices: [2] }],
    ["the target placeholder does not exist", { targetIds: [99] }],
  ])("keeps the account active when %s", (_label, change) => {
    const decision = { ...concerning, commands: [0, 1] };
    expect(decideEnforcement(confirmation(change), prepared, decision)).toEqual(
      { block: false, reason: "intent_not_established" },
    );
  });

  it("keeps the account active when the observed action was only scanning", () => {
    expect(
      decideEnforcement(confirmation(), prepared, {
        ...concerning,
        activity: "network_scanning",
      }),
    ).toEqual({ block: false, reason: "intent_not_established" });
  });

  it("requires the first, independent pass to have cited the same command", () => {
    expect(
      decideEnforcement(confirmation(), prepared, {
        ...concerning,
        commands: [1],
      }),
    ).toEqual({ block: false, reason: "intent_not_established" });
  });

  it("abstains on out-of-range or excessive citations", () => {
    for (const change of [
      { messageIndices: [0] },
      { commandIndices: [3] },
      { commandIndices: Array.from({ length: 11 }, () => 1) },
      { targetIds: [1, 2, 3, 4, 5, 6] },
    ])
      expect(
        decideEnforcement(confirmation(change), prepared, concerning),
      ).toEqual({ block: false, reason: "inconclusive" });
  });

  it("never blocks a lab target, even with explicit intent", () => {
    const lab = prepareReview(
      evidence(
        ["synthetic statement of intent against lab.internal"],
        ["synthetic-tool --target lab.internal"],
      ),
      BURST,
    );
    expect(decideEnforcement(confirmation(), lab, concerning)).toEqual({
      block: false,
      reason: "intent_not_established",
    });
  });

  it("never runs past a review that did not already find concerning, unauthorized activity", () => {
    for (const decision of [
      { outcome: "no_case", reason: "legitimate_corroborated" },
      { outcome: "manual_review", reason: "ambiguous" },
    ] as const)
      expect(
        decideEnforcement(confirmation(), prepared, {
          ...decision,
          activity: concerning.activity,
          commands: [0],
          messages: [0],
        }),
      ).toEqual({ block: false, reason: "intent_not_established" });
  });
});

describe("keepActiveReason", () => {
  it("distinguishes legitimate, coverage, inconclusive and unlinked outcomes", () => {
    expect(
      keepActiveReason({
        outcome: "no_case",
        reason: "legitimate_corroborated",
      }),
    ).toBe("legitimate_corroborated");
    expect(
      keepActiveReason({ outcome: "manual_review", reason: "multiple_runs" }),
    ).toBe("coverage_incomplete");
    expect(
      keepActiveReason({ outcome: "manual_review", reason: "privacy_guard" }),
    ).toBe("coverage_incomplete");
    expect(
      keepActiveReason({ outcome: "manual_review", reason: "ambiguous" }),
    ).toBe("inconclusive");
    expect(
      keepActiveReason({
        outcome: "manual_review",
        reason: "account_activity_concerning",
      }),
    ).toBe("unlinked_history");
    expect(
      keepActiveReason({
        outcome: "authorization_request",
        reason: "concerning_unauthorized",
      }),
    ).toBe("intent_not_established");
  });
});

it("asks the narrow question over the same scrubbed evidence", () => {
  const prompt = buildIntentConfirmationPrompt(prepared);
  expect(prompt).toContain("[M1]");
  expect(prompt).toContain("[C2]");
  expect(prompt).toContain("[T1:public-host]");
  expect(prompt).not.toContain(TARGET);
  expect(prompt).not.toContain(OTHER);
  expect(prompt).not.toContain("Choose exactly one verdict");
});

describe("buildBlockNotice", () => {
  const reference = "AB-0123abcd-0123-4abc-8abc-0123456789ab";

  it("is fixed text that does not claim running work was stopped", () => {
    const notice = buildBlockNotice({ reference, blockedAt: BURST.end });
    expect(notice.from).toBe("abuse@hackerai.co");
    expect(notice.subject).toContain(reference);
    expect(notice.text).toContain(reference);
    expect(notice.text).toContain("https://hackerai.co/abuse");
    expect(notice.text).not.toMatch(/stopp|terminat|kill|cancel/i);
  });

  it("refuses anything but a case reference", () => {
    expect(() =>
      buildBlockNotice({ reference: "AB-x\r\nBcc: y", blockedAt: 0 }),
    ).toThrow("Invalid notice reference");
  });
});
