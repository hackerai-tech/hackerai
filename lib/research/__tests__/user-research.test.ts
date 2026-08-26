import {
  assertResearchPromptIsSafe,
  buildCohortPrompt,
  buildUserProfilePrompt,
  containsUnredactedResearchSecret,
  normalizeCohortSynthesis,
  normalizeResearchUserProfile,
  sanitizeResearchText,
  USER_RESEARCH_MAX_COHORT_CONTEXT_CHARS,
  USER_RESEARCH_MAX_CONTEXT_CHARS,
  USER_RESEARCH_MODEL_KEY,
  pmUserResearchGatewayRequestSchema,
  USER_RESEARCH_PROVIDER_OPTIONS,
} from "../user-research";

const baseProfile = {
  summary: "A recurring security workflow.",
  userTypes: [
    {
      type: "bug_bounty_hunter" as const,
      evidenceCount: 9,
      confidence: "high" as const,
    },
  ],
  declaredContext: null,
  recurringJobs: [
    {
      label: "Validate findings",
      description: "Repeated validation work.",
      evidenceCount: 9,
      confidence: "high" as const,
    },
  ],
  workflowPatterns: [],
  toolsAndEnvironments: [],
  valueDrivers: [],
  frictionAndUnmetNeeds: [],
  reasonsToPay: [],
  confidence: "high" as const,
  uncertainty: [],
};

describe("user research privacy controls", () => {
  it("accepts a bounded request without a Linear reference", () => {
    const request = {
      question: "What recurring work creates the most customer value?",
      cohortLabel: "PostHog top-spender research cohort",
      userIds: ["user-1", "user-2", "user-3"],
      cohortSelectedAt: Date.UTC(2026, 7, 25),
      selectionQueryFingerprint:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      maxChatsPerUser: 12,
    };

    expect(pmUserResearchGatewayRequestSchema.parse(request)).toEqual({
      ...request,
      cohortSource: "posthog",
      posthogProjectId: 144137,
      selectionLimitations: [],
      samplingMode: "representative",
    });
    expect(
      pmUserResearchGatewayRequestSchema.parse({
        ...request,
        linearIssueId: "HAC-65",
      }).linearIssueId,
    ).toBe("HAC-65");
    expect(
      pmUserResearchGatewayRequestSchema.safeParse({
        ...request,
        cohortSelectedAt: undefined,
      }).success,
    ).toBe(false);
    expect(
      pmUserResearchGatewayRequestSchema.safeParse({
        ...request,
        selectionQueryFingerprint: undefined,
      }).success,
    ).toBe(false);
  });

  it("requires a bounded anchor for every user in pre-event research", () => {
    const request = {
      question: "What friction appeared before these users cancelled?",
      cohortLabel: "Recent paid cancellation cohort",
      userIds: ["user-1", "user-2", "user-3"],
      cohortSelectedAt: Date.UTC(2026, 7, 25),
      selectionQueryFingerprint:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      samplingMode: "pre_event",
      evidenceWindowDays: 60,
      evidenceAnchors: [
        { userId: "user-1", anchorAt: Date.UTC(2026, 7, 20) },
        { userId: "user-2", anchorAt: Date.UTC(2026, 7, 21) },
        { userId: "user-3", anchorAt: Date.UTC(2026, 7, 22) },
      ],
      maxChatsPerUser: 12,
    };

    expect(pmUserResearchGatewayRequestSchema.parse(request)).toMatchObject({
      samplingMode: "pre_event",
      evidenceWindowDays: 60,
      evidenceAnchors: request.evidenceAnchors,
    });
    expect(() =>
      pmUserResearchGatewayRequestSchema.parse({
        ...request,
        evidenceAnchors: request.evidenceAnchors.slice(0, 2),
      }),
    ).toThrow("one evidence anchor for every cohort user");
  });

  it("pins Grok 4.6 for text-only research with low reasoning", () => {
    expect(USER_RESEARCH_MODEL_KEY).toBe("model-grok-4.6");
    expect(USER_RESEARCH_PROVIDER_OPTIONS).toEqual({
      openrouter: {
        reasoning: { enabled: true, effort: "low" },
        usage: { include: true },
        provider: { zdr: true },
      },
    });
  });

  it("removes direct identifiers, targets, secrets, code, and command arguments", () => {
    const sanitized =
      sanitizeResearchText(`Contact sam@example.com about https://target.example.com/a.
Host 192.168.10.20 and id 550e8400-e29b-41d4-a716-446655440000.
api_key=super-secret
\`\`\`bash
curl https://target.example.com/private -H "Authorization: Bearer token"
\`\`\`
nmap -sV target.example.com`);

    expect(sanitized).not.toContain("sam@example.com");
    expect(sanitized).not.toContain("target.example.com");
    expect(sanitized).not.toContain("192.168.10.20");
    expect(sanitized).not.toContain("550e8400");
    expect(sanitized).not.toContain("super-secret");
    expect(sanitized).not.toContain("-sV");
    expect(sanitized).toContain("[email omitted]");
    expect(sanitized).toContain("[code omitted]");
    expect(sanitized).toContain("nmap [arguments omitted]");
    expect(sanitizeResearchText("Open customer-report.pdf")).toBe(
      "Open [file omitted]",
    );
  });

  it("redacts standalone provider credentials and private keys", () => {
    const openAiKey = `sk-proj-${"a".repeat(48)}`;
    const githubToken = `ghp_${"b".repeat(36)}`;
    const awsAccessKey = `AKIA${"C".repeat(16)}`;
    const privateKey = `-----BEGIN PRIVATE KEY-----
${"QUJD".repeat(16)}
-----END PRIVATE KEY-----`;
    const sanitized = sanitizeResearchText(
      `Tokens: ${openAiKey} ${githubToken} ${awsAccessKey}\n${privateKey}`,
    );

    expect(sanitized).not.toContain(openAiKey);
    expect(sanitized).not.toContain(githubToken);
    expect(sanitized).not.toContain(awsAccessKey);
    expect(sanitized).not.toContain("BEGIN PRIVATE KEY");
    expect(sanitized.match(/\[secret omitted\]/g)).toHaveLength(4);

    const assigned = sanitizeResearchText(
      "OPENAI_API_KEY=unredacted-value\nAuthorization: Bearer bearer-value",
    );
    expect(assigned).not.toContain("unredacted-value");
    expect(assigned).not.toContain("bearer-value");
    expect(containsUnredactedResearchSecret(assigned)).toBe(false);
  });

  it("fails closed when recognizable secret material reaches a model prompt", () => {
    const leakedSecrets = [
      `sk-proj-${"a".repeat(48)}`,
      `github_pat_${"d".repeat(40)}`,
      `AKIA${"C".repeat(16)}`,
      "-----BEGIN RSA PRIVATE KEY-----",
      "OPENAI_API_KEY=unredacted-value",
      "Authorization: Bearer unredacted-value",
      "eyJheader.payload.signature",
    ];

    for (const leakedSecret of leakedSecrets) {
      expect(containsUnredactedResearchSecret(leakedSecret)).toBe(true);
      expect(() =>
        assertResearchPromptIsSafe(`Evidence: ${leakedSecret}`),
      ).toThrow("Research prompt contains unredacted secret material");
    }
    expect(() =>
      assertResearchPromptIsSafe("Evidence: recurring Agent workflows"),
    ).not.toThrow();
  });

  it("removes standalone secrets before constructing the model prompt", () => {
    const leakedToken = `sk-svcacct-${"e".repeat(48)}`;
    const prompt = buildUserProfilePrompt({
      question: "What recurring workflows appear?",
      pseudonym: "U01",
      chats: [
        {
          chatId: "never-included",
          updatedAt: Date.UTC(2026, 7, 1),
          mode: "agent",
          truncated: false,
          messages: [{ role: "user", text: `Use ${leakedToken}` }],
        },
      ],
    });

    expect(prompt).not.toContain(leakedToken);
    expect(prompt).toContain("[secret omitted]");
    expect(() => assertResearchPromptIsSafe(prompt)).not.toThrow();
  });

  it("redacts evidence before constructing the model prompt", () => {
    const prompt = buildUserProfilePrompt({
      question: "What does this user repeatedly do?",
      pseudonym: "U01",
      chats: [
        {
          chatId: "never-included",
          updatedAt: Date.UTC(2026, 7, 1),
          mode: "agent",
          truncated: false,
          messages: [
            {
              role: "user",
              text: "Test https://private.example.com with api_key=abcd",
            },
          ],
        },
      ],
    });

    expect(prompt).not.toContain("never-included");
    expect(prompt).not.toContain("private.example.com");
    expect(prompt).not.toContain("abcd");
    expect(prompt).toContain("[url omitted]");
  });

  it("keeps first and last evidence from every chat within the context budget", () => {
    const chats = Array.from({ length: 12 }, (_, chatIndex) => ({
      chatId: `chat-${chatIndex}`,
      updatedAt: Date.UTC(2026, 7, chatIndex + 1),
      mode: "agent" as const,
      truncated: true,
      messages: Array.from({ length: 80 }, (_, messageIndex) => ({
        role: (messageIndex % 2 === 0 ? "user" : "assistant") as
          "user" | "assistant",
        text: `${
          messageIndex === 0
            ? `first-${chatIndex}`
            : messageIndex === 79
              ? `last-${chatIndex}`
              : "middle"
        } ${"x".repeat(2_500)}`,
      })),
    }));
    const prompt = buildUserProfilePrompt({
      question: "What recurring workflows appear?",
      pseudonym: "U01",
      chats,
    });

    expect(prompt.length).toBeLessThan(USER_RESEARCH_MAX_CONTEXT_CHARS);
    for (let index = 0; index < chats.length; index += 1) {
      expect(prompt).toContain(`first-${index}`);
      expect(prompt).toContain(`last-${index}`);
    }
  });

  it("keeps every profile in a valid bounded cohort payload", () => {
    const prompt = buildCohortPrompt({
      question: "Which recurring user types and jobs appear?",
      cohortLabel: "PostHog paid cohort",
      researchBasis: {
        cohortSource: "posthog",
        posthogProjectId: 144137,
        cohortSelectedAt: Date.UTC(2026, 7, 25),
        selectionQueryFingerprint:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        selectionLimitations: [],
        samplingMode: "representative",
        causalAttributionConfidence: "low",
      },
      profiles: Array.from({ length: 20 }, (_, index) => ({
        pseudonym: `U${String(index + 1).padStart(2, "0")}`,
        profile: {
          ...baseProfile,
          summary: `profile-${index} ${"summary ".repeat(500)}`,
          recurringJobs: Array.from({ length: 8 }, (_, jobIndex) => ({
            label: `job-${jobIndex}`,
            description: "description ".repeat(100),
            evidenceCount: 10,
            confidence: "high" as const,
          })),
        },
        coverage: {
          chatsReviewed: 12,
          messagesReviewed: 240,
          askChats: 4,
          agentChats: 8,
          samplingMode: "representative" as const,
          truncatedChats: 2,
        },
      })),
    });
    const payload = prompt.split("Synthesize this cohort:\n")[1];
    const parsed = JSON.parse(payload) as { profiles: Array<unknown> };

    expect(prompt.length).toBeLessThan(USER_RESEARCH_MAX_COHORT_CONTEXT_CHARS);
    expect(parsed.profiles).toHaveLength(20);
    expect(payload).toContain("profile-0");
    expect(payload).toContain("profile-19");
    expect(payload).toContain("bug_bounty_hunter");
    expect(payload).toContain('"confidence":"high"');
    expect(payload).toContain('"causalAttributionConfidence":"low"');
    expect(payload).not.toContain(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
  });

  it("caps model evidence counts and lowers confidence for sparse users", () => {
    const normalized = normalizeResearchUserProfile(baseProfile, 2);

    expect(normalized.userTypes[0].evidenceCount).toBe(2);
    expect(normalized.recurringJobs[0].evidenceCount).toBe(2);
    expect(normalized.confidence).toBe("low");
  });

  it("sanitizes structured model output before storage", () => {
    const normalized = normalizeResearchUserProfile(
      {
        ...baseProfile,
        summary: "Uses https://private.example.com and sam@example.com",
      },
      4,
    );

    expect(normalized.summary).toBe("Uses [url omitted] and [email omitted]");
  });

  it("normalizes cohort references, evidence counts, and identifiers", () => {
    const normalized = normalizeCohortSynthesis(
      {
        answerToQuestion: "See https://private.example.com",
        executiveSummary: "Aggregate summary",
        avatars: [
          {
            name: "Independent Operator",
            definition: "Uses sam@example.com for repeated work",
            mainJob: "Validate security issues",
            supportingUserTypes: ["bug_bounty_hunter"],
            pains: [],
            desiredOutcomes: [],
            reasonsToPay: [],
            productFeatures: [],
            objectionsAndTrustNeeds: [],
            acquisitionHypotheses: [],
            messageHypotheses: [],
            evidenceUserCount: 20,
            confidence: "high",
          },
          {
            name: "Security Learner",
            definition: "Learns practical workflows",
            mainJob: "Build skills",
            supportingUserTypes: ["security_student"],
            pains: [],
            desiredOutcomes: [],
            reasonsToPay: [],
            productFeatures: [],
            objectionsAndTrustNeeds: [],
            acquisitionHypotheses: [],
            messageHypotheses: [],
            evidenceUserCount: 2,
            confidence: "medium",
          },
        ],
        primaryAvatar: "Missing avatar",
        secondaryAvatars: [
          "Security Learner",
          "Missing avatar",
          "Security Learner",
        ],
        crossCohortPatterns: [
          {
            pattern: "Repeated multi-step Agent work",
            basis: "observed",
            evidenceUserCount: 20,
            confidence: "high",
          },
        ],
        unknowns: [],
        followUpExperiments: [],
        privacyNote: "Aggregate only",
      },
      4,
    );

    expect(normalized.answerToQuestion).toBe("See [url omitted]");
    expect(normalized.avatars[0].definition).toBe(
      "Uses [email omitted] for repeated work",
    );
    expect(normalized.avatars[0].evidenceUserCount).toBe(4);
    expect(normalized.crossCohortPatterns[0].evidenceUserCount).toBe(4);
    expect(normalized.primaryAvatar).toBe("Independent Operator");
    expect(normalized.secondaryAvatars).toEqual(["Security Learner"]);
  });
});
