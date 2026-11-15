/**
 * Repeatable domain evaluation of Notes recall context selection.
 *
 * Each scenario is a synthetic practitioner request run through the actual
 * request boundary: latest-task extraction, retrieval scope, selection,
 * serialization and injection into the user message. Only the note lookup
 * is mocked, and it returns the user's whole synthetic library, a superset
 * of what the bounded Convex query retrieves, so every exclusion below is
 * made by the real selector. This evaluates which saved context reaches the
 * model, not the quality of the model's answer; no model or network is used.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { UIMessage } from "ai";
import { getRecheckState } from "@/lib/notes/policy";

const mockLookup = jest.fn<(args: unknown) => Promise<unknown[]>>();
const mockGetNotes = jest.fn();
jest.mock("@/lib/db/actions", () => ({
  getNoteRecallCandidates: (args: unknown) => mockLookup(args),
  getNotes: (...args: unknown[]) => mockGetNotes(...args),
}));
const mockEvent = jest.fn();
jest.mock("@/lib/posthog/server", () => ({
  getPostHogBooleanFlagDecisionForUser: jest.fn(),
  phLogger: { event: (...args: unknown[]) => mockEvent(...args) },
}));
jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

const { injectNotesIntoMessages } =
  require("@/lib/api/chat-stream-helpers") as typeof import("@/lib/api/chat-stream-helpers");
const { getLatestUserTaskText } =
  require("@/lib/notes/recall") as typeof import("@/lib/notes/recall");

/** Fixed evaluation clock, so recheck states never drift with the calendar. */
const NOW = Date.UTC(2026, 10, 15);
const day = (month: number, date: number) => Date.UTC(2026, month - 1, date);

type SyntheticNote = {
  id: string;
  title: string;
  category: "general" | "findings" | "methodology";
  target?: string;
  content: string;
  tags?: string[];
  observedAt?: number;
  recheckAfter?: number;
};

const LIBRARY: SyntheticNote[] = [
  {
    id: "pref-readonly",
    title: "Prefer read-only probes first",
    category: "general",
    content: "Start with GET and HEAD before any state-changing request.",
  },
  {
    id: "shop-idor",
    title: "Invoice export IDOR",
    category: "findings",
    target: "shop.acme.example",
    content: "Invoice export returns other tenants' PDFs by incrementing id.",
    observedAt: day(11, 3),
  },
  {
    id: "shop-reset",
    title: "Password reset token reuse",
    category: "findings",
    target: "shop.acme.example",
    content: "Reset tokens stayed valid after use.",
    observedAt: day(5, 1),
    recheckAfter: day(8, 1),
  },
  {
    id: "shop-admin",
    title: "Admin panel under /internal",
    category: "findings",
    target: "https://shop.acme.example",
    content: "Login page reachable without VPN.",
  },
  {
    // Parent domain: a host never implies its parent.
    id: "acme-parent",
    title: "Corporate SSO quirks",
    category: "findings",
    target: "acme.example",
    content: "Invoice export links bounce through SSO.",
  },
  {
    // Sibling subdomain of the asked host.
    id: "shop-api",
    title: "API rate limit bypass",
    category: "findings",
    target: "api.shop.acme.example",
    content: "Rate limits keyed on X-Forwarded-For.",
  },
  {
    // Other target whose text overlaps the shop task's keywords.
    id: "beta-debug",
    title: "Exposed debug console",
    category: "findings",
    target: "portal.beta.example",
    content: "Invoice export debug endpoint leaks stack traces.",
    observedAt: day(10, 20),
  },
  {
    // General category, but bound to another target.
    id: "beta-scope",
    title: "Beta scope: weekends only",
    category: "general",
    target: "portal.beta.example",
    content: "Testing allowed Saturday and Sunday.",
  },
  {
    id: "zulu-roe",
    title: "Rules of engagement",
    category: "findings",
    target: "label:zulu bank",
    content: "No social engineering; production read-only.",
    observedAt: day(11, 1),
  },
  {
    id: "graphql-batching",
    title: "GraphQL alias batching",
    category: "methodology",
    content: "Combine aliases in one request to multiply guesses.",
    tags: ["graphql"],
  },
  {
    id: "ssrf-pdf",
    title: "SSRF through PDF renderer",
    category: "methodology",
    content: "HTML-to-PDF services fetch attacker-supplied URLs.",
  },
];

/** Only targeted notes, none for the host asked about in the no-match case. */
const ONLY_OTHER_TARGETS = LIBRARY.filter((note) => note.target !== undefined);

/** The row shape the Convex recall query returns, recheck derived at NOW. */
const toCandidate = (note: SyntheticNote) => ({
  note_id: note.id,
  title: note.title,
  category: note.category,
  tags: note.tags ?? [],
  target: note.target,
  observed_at: note.observedAt,
  recheck_after: note.recheckAfter,
  updated_at: note.observedAt ?? day(1, 1),
  recheck: getRecheckState(
    {
      target: note.target,
      category: note.category,
      observed_at: note.observedAt,
      recheck_after: note.recheckAfter,
    },
    NOW,
  ),
  excerpt: note.content,
  excerpt_truncated: false,
});

const user = (text: string, id = "latest"): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

async function recall(
  messages: UIMessage[],
  { library = LIBRARY, notesEnabled = true } = {},
) {
  mockLookup.mockResolvedValue(library.map(toCandidate));
  const injected = await injectNotesIntoMessages(messages, {
    userId: "eval-user",
    subscription: "pro",
    shouldIncludeNotes: notesEnabled,
    relevantRecall: { taskText: getLatestUserTaskText(messages) },
  });
  const latest = injected.at(-1)!.parts[0] as { text: string };
  const block = latest.text.match(/<notes>[\s\S]*<\/notes>/)?.[0] ?? "";
  const lines = new Map(
    [...block.matchAll(/^- \[([^\]]+)\] (.*)$/gm)].map((m) => [m[1], m[2]]),
  );
  const events = new Map(
    mockEvent.mock.calls.map(([name, properties]) => [
      name as string,
      properties as Record<string, unknown>,
    ]),
  );
  return { injected, block, lines, recalled: [...lines.keys()].sort(), events };
}

beforeEach(() => {
  mockLookup.mockReset();
  mockGetNotes.mockReset();
  mockEvent.mockReset();
});

describe("Notes recall domain evaluation (context selection only)", () => {
  it.each([
    {
      scenario: "retesting a named host",
      messages: [
        user("Retest the invoice export IDOR on https://shop.acme.example"),
      ],
      expected: ["pref-readonly", "shop-admin", "shop-idor", "shop-reset"],
    },
    {
      scenario: "a different host with overlapping keywords",
      messages: [
        user(
          "Check portal.beta.example: is the invoice export debug console still up?",
        ),
      ],
      expected: ["beta-debug", "beta-scope", "pref-readonly"],
    },
    {
      scenario: "an engagement label named in the task",
      messages: [user("Continue the Zulu Bank engagement with the login flow")],
      expected: ["pref-readonly", "zulu-roe"],
    },
    {
      scenario: "an untargeted technique with no host",
      messages: [user("Any tricks for GraphQL brute force under rate limits?")],
      expected: ["graphql-batching", "pref-readonly"],
    },
    {
      scenario: "switching hosts mid-chat",
      messages: [
        user("Retest https://shop.acme.example invoices", "earlier"),
        { ...user("Done."), id: "reply", role: "assistant" as const },
        user("Now look at portal.beta.example instead"),
      ],
      expected: ["beta-debug", "beta-scope", "pref-readonly"],
    },
  ])(
    "$scenario: injects exactly the applicable notes",
    async ({ messages, expected }) => {
      const { recalled, events } = await recall(messages);
      expect(recalled).toEqual(expected);
      expect(mockGetNotes).not.toHaveBeenCalled();
      expect(events.get("notes_recall_result")).toMatchObject({
        outcome: "hit",
        note_count: expected.length,
      });
      expect(events.get("notes_recall_exposed")).toMatchObject({
        note_count: expected.length,
      });
    },
  );

  it("labels overdue and undated observations and counts only those injected", async () => {
    const { lines, events } = await recall([
      user("Retest the invoice export IDOR on https://shop.acme.example"),
    ]);
    expect(lines.get("shop-reset")).toContain(
      "observed 2026-05-01, recheck due",
    );
    expect(lines.get("shop-admin")).toContain("observation date unknown");
    expect(lines.get("shop-idor")).toContain("observed 2026-11-03)");
    expect(lines.get("shop-idor")).not.toMatch(/recheck|unknown/);
    expect(lines.get("pref-readonly")).not.toMatch(/observ|recheck/);
    // Other targets' undated notes were retrieved but never injected.
    expect(events.get("notes_recall_exposed")).toMatchObject({
      recheck_due_count: 1,
      observation_date_unknown_count: 1,
    });
  });

  it("injects nothing when only other targets' notes exist", async () => {
    const messages = [user("Enumerate subdomains of gamma.example")];
    const { injected, block, events } = await recall(messages, {
      library: ONLY_OTHER_TARGETS,
    });
    expect(block).toBe("");
    expect(injected).toEqual(messages);
    expect(events.get("notes_recall_result")).toMatchObject({
      outcome: "no_match",
      candidate_count: ONLY_OTHER_TARGETS.length,
    });
    expect(events.has("notes_recall_exposed")).toBe(false);
  });

  it("with Notes turned off, neither looks up nor injects nor records", async () => {
    const messages = [user("Retest https://shop.acme.example invoices")];
    const { injected } = await recall(messages, { notesEnabled: false });
    expect(injected).toBe(messages);
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockGetNotes).not.toHaveBeenCalled();
    expect(mockEvent).not.toHaveBeenCalled();
  });
});
