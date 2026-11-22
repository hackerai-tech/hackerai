import type { BrowserBridgeFailureContext } from "../bridge-program";
import {
  PREVIEW_ACTIVATION_PARAM,
  PREVIEW_CLIENT_CONTEXT_KEY,
  PREVIEW_DIAGNOSTIC_VERSION_PARAM,
  PREVIEW_READER_PARAM,
  PREVIEW_TERMINAL_INTENT_KEY,
  PREVIEW_TERMINAL_INTENT_PARAM,
  PREVIEW_TERMINAL_OTHER_KIND_KEY,
  PREVIEW_TERMINAL_OTHER_KIND_PARAM,
  PREVIEW_TERMINAL_PHASE_PARAM,
  PREVIEW_TERMINAL_PHASES,
  PREVIEW_TEXT_SOURCE_PARAM,
  PREVIEW_TEXT_SOURCES,
  parsePreviewClientContext,
  previewActivationMask,
  previewCaptureUrl,
  withPreviewClientContext,
} from "../preview-activation-diagnostics";
import type { BrowserCaptureFailureContext } from "../server";
import { phLogger } from "@/lib/posthog/server";
import {
  AGENT_BROWSER_OTHER_ONLY_KINDS,
  AGENT_BROWSER_PREVIEW_INTENTS,
  agentBrowserPreviewIntent,
} from "@/lib/utils/agent-browser-command";

const READER = "0123456789abcdef0123456789abcdef01234567";
const SERVER_BUILD = "fedcba9876543210fedcba9876543210fedcba98";
const ENDPOINT = "/api/agent/browser/0123456789abcdef0123456789abcdef";
const CANARIES = [
  "PRIVATE_COMMAND",
  "PRIVATE_SESSION_NAME",
  "https://private.example/target",
  "PRIVATE_NOTE",
  "PRIVATE_GRANT",
  "PRIVATE_COOKIE",
];
const STATES = ["waiting", "claiming", "human", "recovery", "resuming"];

const query = (entries: Array<[string, string]>) =>
  new URLSearchParams(entries);
const group = (
  activation = "39",
  reader = READER,
  version = "1",
): Array<[string, string]> => [
  [PREVIEW_DIAGNOSTIC_VERSION_PARAM, version],
  [PREVIEW_ACTIVATION_PARAM, activation],
  [PREVIEW_READER_PARAM, reader],
];

/** Every mask a client can produce from its real sources, including non-gate states. */
const reachableMasks = () => {
  const masks = new Set<number>();
  for (const browserRequested of [false, true])
    for (const fullScreen of [false, true])
      for (const hasTakenControl of [false, true])
        for (const sessionState of [
          undefined,
          "agent",
          "closed",
          "future_state",
          ...STATES,
        ])
          masks.add(
            previewActivationMask({
              browserRequested,
              fullScreen,
              hasTakenControl,
              sessionState,
            }),
          );
  return masks;
};

describe("client activation mask", () => {
  it("assigns each showPreview source its documented bit", () => {
    const none = {
      browserRequested: false,
      fullScreen: false,
      hasTakenControl: false,
      sessionState: "agent",
    };
    expect(previewActivationMask(none)).toBe(0);
    expect(previewActivationMask({ ...none, browserRequested: true })).toBe(1);
    expect(previewActivationMask({ ...none, fullScreen: true })).toBe(2);
    expect(previewActivationMask({ ...none, hasTakenControl: true })).toBe(4);
    expect(
      STATES.map((sessionState) =>
        previewActivationMask({ ...none, sessionState }),
      ),
    ).toEqual([8, 16, 32, 64, 128]);
    for (const sessionState of [undefined, null, "closed", "Waiting", 8])
      expect(previewActivationMask({ ...none, sessionState })).toBe(0);
    expect(
      previewActivationMask({
        browserRequested: true,
        fullScreen: true,
        hasTakenControl: true,
        sessionState: "recovery",
      }),
    ).toBe(71);
  });

  it("is nonzero exactly when the component's showPreview gate is true", () => {
    for (const browserRequested of [false, true])
      for (const fullScreen of [false, true])
        for (const hasTakenControl of [false, true])
          for (const sessionState of [undefined, "agent", "closed", ...STATES])
            expect(
              previewActivationMask({
                browserRequested,
                fullScreen,
                hasTakenControl,
                sessionState,
              }) !== 0,
            ).toBe(
              browserRequested ||
                fullScreen ||
                hasTakenControl ||
                STATES.includes(sessionState as string),
            );
  });
});

describe("strict query decoding", () => {
  it("accepts exactly the 48 reachable masks and rejects every other byte", () => {
    const reachable = reachableMasks();
    expect(reachable.size).toBe(48);
    const accepted: number[] = [];
    for (let mask = 0; mask <= 999; mask++) {
      const tuple = parsePreviewClientContext(query(group(`${mask}`)));
      if (tuple === undefined) continue;
      accepted.push(mask);
      expect(JSON.parse(tuple)).toEqual([1, mask, READER]);
      expect(tuple.length).toBeLessThanOrEqual(50);
    }
    expect(accepted).toEqual([...reachable].sort((a, b) => a - b));
  });

  it("normalizes an uppercase commit and keeps the explicit unknown sentinel", () => {
    expect(
      parsePreviewClientContext(query(group("9", READER.toUpperCase()))),
    ).toBe(`[1,9,"${READER}"]`);
    expect(parsePreviewClientContext(query(group("0", "unknown")))).toBe(
      '[1,0,"unknown"]',
    );
  });

  it("treats an absent group as a legacy caller", () => {
    expect(parsePreviewClientContext(query([]))).toBeUndefined();
    expect(parsePreviewClientContext(query([["fresh", "1"]]))).toBeUndefined();
  });

  it.each([
    ["missing version", group().slice(1)],
    ["missing activation", [group()[0], group()[2]]],
    ["missing reader", group().slice(0, 2)],
    ["duplicate identical version", [...group(), group()[0]]],
    ["duplicate identical activation", [...group(), group()[1]]],
    ["duplicate identical reader", [...group(), group()[2]]],
    [
      "conflicting duplicate activation",
      [...group(), [PREVIEW_ACTIVATION_PARAM, "1"]],
    ],
  ] as Array<[string, Array<[string, string]>]>)(
    "drops the whole group for %s",
    (_name, entries) => {
      expect(parsePreviewClientContext(query(entries))).toBeUndefined();
    },
  );

  it.each([
    "",
    "2",
    "0",
    "01",
    "1.0",
    " 1",
    "1 ",
    "v1",
    "+1",
    "１",
    "1".repeat(10_000),
  ])("drops the whole group for version %j", (version) => {
    expect(
      parsePreviewClientContext(query(group("1", READER, version))),
    ).toBeUndefined();
  });

  it.each([
    "",
    "01",
    "007",
    "+1",
    "-0",
    "-1",
    "1.0",
    "1e1",
    "0x1",
    "0b1",
    "NaN",
    "Infinity",
    " 1",
    "1 ",
    "\t1",
    "1\u0000",
    "１",
    "٣",
    "24",
    "136",
    "255",
    "256",
    "1000",
    "9".repeat(10_000),
  ])("drops the whole group for activation %j", (activation) => {
    expect(parsePreviewClientContext(query(group(activation)))).toBeUndefined();
  });

  it.each([
    "",
    "UNKNOWN",
    "Unknown",
    "unknown ",
    " unknown",
    READER.slice(1),
    `${READER}0`,
    `${READER.slice(1)}g`,
    `${READER.slice(1)}\u0000`,
    `${READER.slice(1)}é`,
    "a".repeat(10_000),
    "PRIVATE_COMMAND",
  ])("drops the whole group for reader %j", (reader) => {
    expect(
      parsePreviewClientContext(query(group("1", reader))),
    ).toBeUndefined();
  });

  it("never reads or reflects unrelated parameters", () => {
    const unrelated = CANARIES.map(
      (canary, index) => [`private_${index}`, canary] as [string, string],
    );
    expect(parsePreviewClientContext(query([...unrelated, ...group()]))).toBe(
      `[1,39,"${READER}"]`,
    );
    expect(
      parsePreviewClientContext(
        query([...unrelated, ...group("PRIVATE_COMMAND")]),
      ),
    ).toBeUndefined();
  });
});

describe("capture URL", () => {
  const params = (url: string) =>
    new URL(url, "https://app.example").searchParams;

  it("round-trips every reachable mask for normal and fresh requests", () => {
    for (const mask of reachableMasks())
      for (const fresh of [false, true]) {
        const url = previewCaptureUrl(ENDPOINT, fresh, mask, READER);
        expect(url.startsWith(`${ENDPOINT}?`)).toBe(true);
        expect(parsePreviewClientContext(params(url))).toBe(
          `[1,${mask},"${READER}"]`,
        );
      }
  });

  it("keeps the existing fresh contract an older server reads", () => {
    const fresh = previewCaptureUrl(ENDPOINT, true, 1, READER);
    const normal = previewCaptureUrl(ENDPOINT, false, 1, READER);
    expect(fresh.startsWith(`${ENDPOINT}?fresh=1&`)).toBe(true);
    // The existing route only compares this exact read.
    expect(params(fresh).get("fresh") === "1").toBe(true);
    expect(params(normal).get("fresh") === "1").toBe(false);
    expect(params(normal).has("fresh")).toBe(false);
    expect(new URL(fresh, "https://app.example").pathname).toBe(ENDPOINT);
  });

  it.each([
    [READER.toUpperCase(), READER],
    [READER, READER],
    ["unknown", "unknown"],
    [undefined, "unknown"],
    ["", "unknown"],
    ["not-a-commit", "unknown"],
    [`${READER}0`, "unknown"],
    [42, "unknown"],
  ])("reports the loaded reader %j as %j", (loaded, reported) => {
    const url = previewCaptureUrl(ENDPOINT, false, 1, loaded);
    expect(params(url).get(PREVIEW_READER_PARAM)).toBe(reported);
  });

  it.each([24, -1, 1.5, 256, Number.NaN])(
    "falls back to the legacy URL for an unencodable mask %p",
    (mask) => {
      expect(previewCaptureUrl(ENDPOINT, false, mask, READER)).toBe(ENDPOINT);
      expect(previewCaptureUrl(ENDPOINT, true, mask, READER)).toBe(
        `${ENDPOINT}?fresh=1`,
      );
    },
  );
});

describe("text-source add-on", () => {
  const params = (url: string) =>
    new URL(url, "https://app.example").searchParams;
  const addOn = (value: string): Array<[string, string]> => [
    [PREVIEW_TEXT_SOURCE_PARAM, value],
  ];
  it("round-trips each closed value and keeps the v1 prefix legacy readers parse", () => {
    for (const source of PREVIEW_TEXT_SOURCES)
      for (const liveSelection of [true, false]) {
        const url = previewCaptureUrl(ENDPOINT, true, 71, READER, false, {
          source,
          liveSelection,
        });
        expect(JSON.parse(parsePreviewClientContext(params(url))!)).toEqual([
          1,
          71,
          READER,
          [1, source, liveSelection],
        ]);
      }
    // Older servers read these keys unchanged and ignore the add-on.
    const url = params(
      previewCaptureUrl(ENDPOINT, false, 9, READER, false, {
        source: "brief",
        liveSelection: false,
      }),
    );
    expect(
      [
        PREVIEW_DIAGNOSTIC_VERSION_PARAM,
        PREVIEW_ACTIVATION_PARAM,
        PREVIEW_READER_PARAM,
      ].map((name) => url.getAll(name)),
    ).toEqual([["1"], ["9"], [READER]]);
  });

  it("is sent only beside the browserRequested bit and a boolean selection", () => {
    const sent = (mask: number, source: unknown, liveSelection: unknown) =>
      params(
        previewCaptureUrl(ENDPOINT, true, mask, READER, false, {
          source,
          liveSelection,
        }),
      ).get(PREVIEW_TEXT_SOURCE_PARAM);
    expect(sent(8, "command", true)).toBeNull();
    expect(sent(1, "command", undefined)).toBeNull();
    expect(sent(1, undefined, true)).toBe("1.unavailable.1");
    expect(sent(1, "PRIVATE_COMMAND", false)).toBe("1.unavailable.0");
    expect(
      params(previewCaptureUrl(ENDPOINT, true, 1, READER)).has(
        PREVIEW_TEXT_SOURCE_PARAM,
      ),
    ).toBe(false);
  });

  it("drops a forged add-on beside a mask without the browserRequested bit", () => {
    expect(
      parsePreviewClientContext(query([...group("8"), ...addOn("1.brief.1")])),
    ).toBe(`[1,8,"${READER}"]`);
  });

  it("never rescues an invalid base", () => {
    expect(
      parsePreviewClientContext(query([...group("24"), ...addOn("1.brief.1")])),
    ).toBeUndefined();
  });

  it.each([
    ["duplicate identical", [...addOn("1.brief.1"), ...addOn("1.brief.1")]],
    ["conflicting duplicate", [...addOn("1.brief.1"), ...addOn("1.command.1")]],
    ["future version", addOn("2.brief.1")],
    ["noncanonical selection", addOn("1.brief.true")],
    ["whitespace", addOn("1.brief.1 ")],
    ["prototype key", addOn("__proto__")],
    ["forged content", addOn("1.PRIVATE_COMMAND.1")],
    ["oversized", addOn(`1.brief.${"1".repeat(10_000)}`)],
  ] as Array<[string, Array<[string, string]>]>)(
    "preserves the original v1 base for a %s add-on",
    (_name, entries) => {
      const tuple = parsePreviewClientContext(query([...group(), ...entries]));
      expect(tuple).toBe(`[1,39,"${READER}"]`);
      for (const canary of CANARIES) expect(tuple).not.toContain(canary);
    },
  );

  it("preserves the base if only the add-on cannot be read", () => {
    const real = query(group("1"));
    const hostile = {
      getAll: (name: string) => {
        if (name === PREVIEW_TEXT_SOURCE_PARAM)
          throw new Error("PRIVATE_COOKIE");
        return real.getAll(name);
      },
    } as unknown as URLSearchParams;
    expect(parsePreviewClientContext(hostile)).toBe(`[1,1,"${READER}"]`);
  });
});

describe("terminal intent", () => {
  const params = (url: string) =>
    new URL(url, "https://app.example").searchParams;
  const liveCommand = (intent: unknown) => ({
    source: "command",
    liveSelection: true,
    intent,
  });
  const fieldsWith = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`field_${index}`, index]),
    );

  // `null` is the Browser Preview predicate: every value here is the
  // eligibility the previous boolean returned for the same command.
  it.each([
    ["", null],
    ["echo agent-browser open https://x.test", null],
    ["agent-browser-next open https://x.test", null],
    ["agent-browser --version", null],
    ["agent-browser -h", null],
    ["agent-browser open --help", null],
    ["agent-browser --version && agent-browser --help", null],
    ["# agent-browser open https://x.test", null],
    ["pwd # && agent-browser open https://x.test", null],
    ["agent-browser open https://x.test", "open_only"],
    ["npx -y agent-browser open about:blank # note", "open_only"],
    ["cd /tmp && FOO=1 agent-browser open https://x.test", "open_only"],
    ["agent-browser open --help --headed", "open_only"],
    ["agent-browser --headed open https://x.test", "option_only"],
    ["agent-browser --version extra", "option_only"],
    // A single other-only invocation, refined by its first argument alone.
    ["agent-browser", "other_only.bare"],
    ["npx -y agent-browser # snapshot", "other_only.bare"],
    ["agent-browser 2>/dev/null", "other_only.bare"],
    ["agent-browser snapshot -i", "other_only.known_action"],
    ["FOO=1 npx agent-browser@latest batch", "other_only.known_action"],
    ["agent-browser 'click' @e1", "other_only.known_action"],
    ["agent-browser version", "other_only.unrecognized_action"],
    ["agent-browser help", "other_only.unrecognized_action"],
    ["agent-browser Snapshot", "other_only.unrecognized_action"],
    ['agent-browser ""', "other_only.unrecognized_action"],
    ["agent-browser PRIVATE_COMMAND x", "other_only.unrecognized_action"],
    // Mixed shapes are unchanged by the refinement.
    ["agent-browser --version && agent-browser", "info_with_operation"],
    [
      "agent-browser PRIVATE_COMMAND && agent-browser snapshot",
      "multiple_operations",
    ],
    // Compound: open+other vs two non-OPEN (an option prefix is not resolved).
    [
      "agent-browser open https://x.test && agent-browser snapshot",
      "multiple_with_open",
    ],
    ["agent-browser open a; agent-browser open b", "multiple_with_open"],
    [
      "agent-browser snapshot && agent-browser click @e1",
      "multiple_operations",
    ],
    [
      "agent-browser --headed open a && agent-browser snapshot",
      "multiple_operations",
    ],
    // Compound: version+open vs version+other.
    [
      "agent-browser --version && agent-browser open about:blank",
      "info_with_open",
    ],
    [
      "agent-browser --version && agent-browser snapshot",
      "info_with_operation",
    ],
    [
      "agent-browser open -h\nagent-browser --session s click @e1",
      "info_with_operation",
    ],
  ])("classifies %j as %p", (command, expected) => {
    expect(agentBrowserPreviewIntent(command)).toBe(expected);
  });

  it("is sent only beside a live command source with a closed value", () => {
    const sent = (
      mask: number,
      textSource: Parameters<typeof previewCaptureUrl>[5],
    ) =>
      params(
        previewCaptureUrl(ENDPOINT, true, mask, READER, false, textSource),
      );
    // Every base value, including a legacy unrefined `other_only`, sends no kind.
    for (const intent of AGENT_BROWSER_PREVIEW_INTENTS) {
      const sentQuery = sent(1, liveCommand(intent));
      expect(sentQuery.getAll(PREVIEW_TERMINAL_INTENT_PARAM)).toEqual([
        `1.${intent}`,
      ]);
      expect(sentQuery.has(PREVIEW_TERMINAL_OTHER_KIND_PARAM)).toBe(false);
    }
    const omitted = [
      sent(1, { ...liveCommand("open_only"), liveSelection: false }),
      sent(1, { ...liveCommand("open_only"), source: "brief" }),
      sent(1, { ...liveCommand("open_only"), source: "PRIVATE_COMMAND" }),
      sent(9, { ...liveCommand("open_only"), liveSelection: undefined }),
      sent(8, liveCommand("open_only")),
      sent(1, liveCommand(null)),
      sent(1, liveCommand("PRIVATE_COMMAND")),
      sent(1, liveCommand("__proto__")),
      sent(1, liveCommand(`open_only${"x".repeat(100_000)}`)),
      sent(1, { ...liveCommand("other_only.bare"), liveSelection: false }),
      sent(1, { ...liveCommand("other_only.bare"), source: "brief" }),
      sent(8, liveCommand("other_only.known_action")),
      sent(1, liveCommand("other_only.")),
      sent(1, liveCommand("other_only.PRIVATE_COMMAND")),
      sent(1, liveCommand("other_only.__proto__")),
      sent(1, liveCommand("open_only.bare")),
      sent(1, liveCommand(`other_only.bare${"x".repeat(100_000)}`)),
    ];
    for (const sentQuery of omitted) {
      expect(sentQuery.has(PREVIEW_TERMINAL_INTENT_PARAM)).toBe(false);
      expect(sentQuery.has(PREVIEW_TERMINAL_OTHER_KIND_PARAM)).toBe(false);
    }
    // The intent never alters the parameters older servers read.
    expect(
      [...sent(1, liveCommand("open_only")).entries()].filter(
        ([name]) => name !== PREVIEW_TERMINAL_INTENT_PARAM,
      ),
    ).toEqual([...sent(1, liveCommand(undefined)).entries()]);
  });

  it("sends a refined other-only intent as the unchanged base plus one kind", () => {
    const sentFor = (intent: string) =>
      params(
        previewCaptureUrl(
          ENDPOINT,
          true,
          1,
          READER,
          false,
          liveCommand(intent),
        ),
      );
    const legacy = [...sentFor("other_only").entries()];
    for (const kind of AGENT_BROWSER_OTHER_ONLY_KINDS) {
      const sentQuery = sentFor(`other_only.${kind}`);
      expect(sentQuery.getAll(PREVIEW_TERMINAL_INTENT_PARAM)).toEqual([
        "1.other_only",
      ]);
      expect(sentQuery.getAll(PREVIEW_TERMINAL_OTHER_KIND_PARAM)).toEqual([
        `1.${kind}`,
      ]);
      // Older servers and queries read exactly the legacy `other_only` request.
      expect(
        [...sentQuery.entries()].filter(
          ([name]) => name !== PREVIEW_TERMINAL_OTHER_KIND_PARAM,
        ),
      ).toEqual(legacy);
    }
  });

  it.each([
    ["agent-browser", '[1,"bare"]'],
    ["agent-browser snapshot -i", '[1,"known_action"]'],
    [
      "agent-browser PRIVATE_COMMAND --flag PRIVATE_NOTE",
      '[1,"unrecognized_action"]',
    ],
  ])(
    "carries %j from the parser to bounded log attributes without its text",
    (command, kind) => {
      const refined = agentBrowserPreviewIntent(command);
      const url = previewCaptureUrl(
        ENDPOINT,
        true,
        1,
        READER,
        false,
        liveCommand(refined),
      );
      expect(url).not.toContain("PRIVATE");
      const fields = fieldsWith(3);
      const result = withPreviewClientContext(fields, params(url));
      expect(Object.keys(result)).toEqual([
        ...Object.keys(fields),
        PREVIEW_CLIENT_CONTEXT_KEY,
        PREVIEW_TERMINAL_INTENT_KEY,
        PREVIEW_TERMINAL_OTHER_KIND_KEY,
      ]);
      expect(result[PREVIEW_TERMINAL_INTENT_KEY]).toBe('[1,"other_only"]');
      expect(result[PREVIEW_TERMINAL_OTHER_KIND_KEY]).toBe(kind);
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
    },
  );

  it("appends one validated attribute after the unchanged tuple", () => {
    const fields = fieldsWith(11);
    for (const intent of AGENT_BROWSER_PREVIEW_INTENTS) {
      const query = params(
        previewCaptureUrl(
          ENDPOINT,
          true,
          71,
          READER,
          false,
          liveCommand(intent),
        ),
      );
      const result = withPreviewClientContext(fields, query);
      expect(Object.keys(result)).toEqual([
        ...Object.keys(fields),
        PREVIEW_CLIENT_CONTEXT_KEY,
        PREVIEW_TERMINAL_INTENT_KEY,
      ]);
      expect(result[PREVIEW_CLIENT_CONTEXT_KEY]).toBe(
        `[1,71,"${READER}",[1,"command",true]]`,
      );
      expect(result[PREVIEW_CLIENT_CONTEXT_KEY]).toBe(
        parsePreviewClientContext(query),
      );
      expect(result[PREVIEW_TERMINAL_INTENT_KEY]).toBe(`[1,"${intent}"]`);
    }
  });

  const intent = (value: string): Array<[string, string]> => [
    [PREVIEW_TERMINAL_INTENT_PARAM, value],
  ];
  const source = (value: string): Array<[string, string]> => [
    [PREVIEW_TEXT_SOURCE_PARAM, value],
  ];
  it.each([
    ["absent source", group("1"), intent("1.open_only")],
    [
      "history selection",
      [...group("1"), ...source("1.command.0")],
      intent("1.open_only"),
    ],
    [
      "brief source",
      [...group("1"), ...source("1.brief.1")],
      intent("1.open_only"),
    ],
    [
      "invalid source",
      [...group("1"), ...source("1.command.true")],
      intent("1.open_only"),
    ],
    [
      "duplicate source",
      [...group("1"), ...source("1.command.1"), ...source("1.command.1")],
      intent("1.open_only"),
    ],
    [
      "mask without browserRequested",
      [...group("8"), ...source("1.command.1")],
      intent("1.open_only"),
    ],
    [
      "invalid base",
      [...group("24"), ...source("1.command.1")],
      intent("1.open_only"),
    ],
    [
      "future base",
      [...group("1", READER, "2"), ...source("1.command.1")],
      intent("1.open_only"),
    ],
    ["absent intent", [...group("1"), ...source("1.command.1")], []],
    [
      "duplicate intent",
      [...group("1"), ...source("1.command.1")],
      [...intent("1.open_only"), ...intent("1.open_only")],
    ],
    [
      "future intent",
      [...group("1"), ...source("1.command.1")],
      intent("2.open_only"),
    ],
    [
      "unversioned intent",
      [...group("1"), ...source("1.command.1")],
      intent("open_only"),
    ],
    [
      "injected intent",
      [...group("1"), ...source("1.command.1")],
      intent('1.open_only","PRIVATE_COMMAND'),
    ],
    [
      "forged intent",
      [...group("1"), ...source("1.command.1")],
      intent("1.PRIVATE_COMMAND"),
    ],
    [
      "prototype intent",
      [...group("1"), ...source("1.command.1")],
      intent("__proto__"),
    ],
    [
      "oversized intent",
      [...group("1"), ...source("1.command.1")],
      intent(`1.open_only${" ".repeat(10_000)}`),
    ],
  ] as Array<[string, Array<[string, string]>, Array<[string, string]>]>)(
    "omits only the intent for a %s",
    (_name, base, extra) => {
      const fields = fieldsWith(3);
      const baseline = withPreviewClientContext(fields, query(base));
      const result = withPreviewClientContext(
        fields,
        query([...base, ...extra]),
      );
      expect(result).toEqual(baseline);
      expect(result).not.toHaveProperty(PREVIEW_TERMINAL_INTENT_KEY);
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
    },
  );

  const kind = (value: string): Array<[string, string]> => [
    [PREVIEW_TERMINAL_OTHER_KIND_PARAM, value],
  ];
  const liveOther = [
    ...group("1"),
    ...source("1.command.1"),
    ...intent("1.other_only"),
  ];
  it.each([
    ["absent kind", liveOther, []],
    ["duplicate kind", liveOther, [...kind("1.bare"), ...kind("1.bare")]],
    [
      "conflicting duplicate kind",
      liveOther,
      [...kind("1.bare"), ...kind("1.known_action")],
    ],
    ["future kind", liveOther, kind("2.bare")],
    ["unversioned kind", liveOther, kind("bare")],
    ["whitespace kind", liveOther, kind("1.bare ")],
    ["forged kind", liveOther, kind("1.PRIVATE_COMMAND")],
    ["prototype kind", liveOther, kind("__proto__")],
    ["injected kind", liveOther, kind('1.bare","PRIVATE_COMMAND')],
    ["oversized kind", liveOther, kind(`1.bare${" ".repeat(10_000)}`)],
    [
      "non-other intent",
      [...group("1"), ...source("1.command.1"), ...intent("1.open_only")],
      kind("1.bare"),
    ],
    [
      "mixed intent",
      [
        ...group("1"),
        ...source("1.command.1"),
        ...intent("1.multiple_operations"),
      ],
      kind("1.unrecognized_action"),
    ],
    [
      "absent intent",
      [...group("1"), ...source("1.command.1")],
      kind("1.bare"),
    ],
    [
      "refined intent value",
      [...group("1"), ...source("1.command.1"), ...intent("1.other_only.bare")],
      kind("1.bare"),
    ],
    [
      "duplicate other intent",
      [...liveOther, ...intent("1.other_only")],
      kind("1.bare"),
    ],
    [
      "history selection",
      [...group("1"), ...source("1.command.0"), ...intent("1.other_only")],
      kind("1.bare"),
    ],
    [
      "brief source",
      [...group("1"), ...source("1.brief.1"), ...intent("1.other_only")],
      kind("1.bare"),
    ],
    [
      "mask without browserRequested",
      [...group("8"), ...source("1.command.1"), ...intent("1.other_only")],
      kind("1.bare"),
    ],
    [
      "invalid base",
      [...group("24"), ...source("1.command.1"), ...intent("1.other_only")],
      kind("1.bare"),
    ],
  ] as Array<[string, Array<[string, string]>, Array<[string, string]>]>)(
    "omits only the other-only kind for a %s",
    (_name, base, extra) => {
      const fields = fieldsWith(3);
      const baseline = withPreviewClientContext(fields, query(base));
      const result = withPreviewClientContext(
        fields,
        query([...base, ...extra]),
      );
      expect(result).toEqual(baseline);
      expect(result).not.toHaveProperty(PREVIEW_TERMINAL_OTHER_KIND_KEY);
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
    },
  );

  it("never gives the kind the intent's or tuple's slot or an existing field", () => {
    const url = params(
      previewCaptureUrl(
        ENDPOINT,
        true,
        1,
        READER,
        false,
        liveCommand("other_only.unrecognized_action"),
      ),
    );
    const legacyUrl = params(
      previewCaptureUrl(
        ENDPOINT,
        true,
        1,
        READER,
        false,
        liveCommand("other_only"),
      ),
    );
    const withKind = withPreviewClientContext(fieldsWith(68), url);
    expect(Object.keys(withKind)).toHaveLength(71);
    expect(withKind[PREVIEW_TERMINAL_OTHER_KIND_KEY]).toBe(
      '[1,"unrecognized_action"]',
    );
    // From 69 fields on, every result equals the legacy other_only result.
    for (const count of [69, 70, 71])
      expect(withPreviewClientContext(fieldsWith(count), url)).toEqual(
        withPreviewClientContext(fieldsWith(count), legacyUrl),
      );
    const withIntent = withPreviewClientContext(fieldsWith(69), url);
    expect(withIntent[PREVIEW_TERMINAL_INTENT_KEY]).toBe('[1,"other_only"]');
    const full = fieldsWith(71);
    expect(withPreviewClientContext(full, url)).toBe(full);
    // A conflicting baseline kind is kept; the intent still appends.
    const existingKind = {
      ...fieldsWith(3),
      [PREVIEW_TERMINAL_OTHER_KIND_KEY]: "server",
    };
    expect(withPreviewClientContext(existingKind, url)).toEqual({
      ...existingKind,
      [PREVIEW_CLIENT_CONTEXT_KEY]: `[1,1,"${READER}",[1,"command",true]]`,
      [PREVIEW_TERMINAL_INTENT_KEY]: '[1,"other_only"]',
    });
    // A conflicting baseline intent suppresses both the intent and its kind.
    const existingIntent = {
      ...fieldsWith(3),
      [PREVIEW_TERMINAL_INTENT_KEY]: "server",
    };
    expect(withPreviewClientContext(existingIntent, url)).toEqual({
      ...existingIntent,
      [PREVIEW_CLIENT_CONTEXT_KEY]: `[1,1,"${READER}",[1,"command",true]]`,
    });
  });

  it("keeps the tuple and intent if only the kind cannot be read", () => {
    const real = params(
      previewCaptureUrl(
        ENDPOINT,
        true,
        1,
        READER,
        false,
        liveCommand("other_only.bare"),
      ),
    );
    const hostile = {
      getAll: (name: string) => {
        if (name === PREVIEW_TERMINAL_OTHER_KIND_PARAM)
          throw new Error("PRIVATE_COOKIE");
        return real.getAll(name);
      },
    } as unknown as URLSearchParams;
    const fields = fieldsWith(3);
    expect(withPreviewClientContext(fields, hostile)).toEqual({
      ...fields,
      [PREVIEW_CLIENT_CONTEXT_KEY]: `[1,1,"${READER}",[1,"command",true]]`,
      [PREVIEW_TERMINAL_INTENT_KEY]: '[1,"other_only"]',
    });
  });

  it("keeps the tuple's headroom and never replaces an existing field", () => {
    const url = params(
      previewCaptureUrl(
        ENDPOINT,
        true,
        1,
        READER,
        false,
        liveCommand("open_only"),
      ),
    );
    const withIntent = withPreviewClientContext(fieldsWith(69), url);
    expect(Object.keys(withIntent)).toHaveLength(71);
    expect(withIntent[PREVIEW_TERMINAL_INTENT_KEY]).toBe('[1,"open_only"]');
    // The tuple's last slot is not given to the intent.
    const tupleOnly = withPreviewClientContext(fieldsWith(70), url);
    expect(Object.keys(tupleOnly)).toEqual([
      ...Object.keys(fieldsWith(70)),
      PREVIEW_CLIENT_CONTEXT_KEY,
    ]);
    const full = fieldsWith(71);
    expect(withPreviewClientContext(full, url)).toBe(full);
    const existing = {
      ...fieldsWith(3),
      [PREVIEW_TERMINAL_INTENT_KEY]: "server",
    };
    expect(withPreviewClientContext(existing, url)).toEqual({
      ...existing,
      [PREVIEW_CLIENT_CONTEXT_KEY]: `[1,1,"${READER}",[1,"command",true]]`,
    });
  });

  it("keeps the tuple if only the intent cannot be read", () => {
    const real = params(
      previewCaptureUrl(
        ENDPOINT,
        true,
        1,
        READER,
        false,
        liveCommand("open_only"),
      ),
    );
    const hostile = {
      getAll: (name: string) => {
        if (name === PREVIEW_TERMINAL_INTENT_PARAM)
          throw new Error("PRIVATE_COOKIE");
        return real.getAll(name);
      },
    } as unknown as URLSearchParams;
    const fields = fieldsWith(3);
    expect(withPreviewClientContext(fields, hostile)).toEqual({
      ...fields,
      [PREVIEW_CLIENT_CONTEXT_KEY]: `[1,1,"${READER}",[1,"command",true]]`,
    });
  });
});

describe("terminal phase", () => {
  const params = (url: string) =>
    new URL(url, "https://app.example").searchParams;
  const fieldsWith = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`field_${index}`, index]),
    );
  const command = (liveSelection: unknown, phase: unknown, intent?: unknown) =>
    ({ source: "command", liveSelection, intent, phase }) as const;

  it("carries each closed phase as a fifth tuple element for live and historical commands", () => {
    for (const phase of PREVIEW_TERMINAL_PHASES)
      for (const live of [true, false]) {
        const sent = params(
          previewCaptureUrl(ENDPOINT, false, 1, READER, false, {
            ...command(live, phase, "multiple_operations"),
          }),
        );
        expect(sent.getAll(PREVIEW_TERMINAL_PHASE_PARAM)).toEqual([
          `1.${phase}`,
        ]);
        const legacy = parsePreviewClientContext(
          query(
            [...sent.entries()].filter(
              ([name]) => name !== PREVIEW_TERMINAL_PHASE_PARAM,
            ),
          ),
        );
        const tuple = JSON.parse(parsePreviewClientContext(sent)!);
        expect(tuple).toEqual([1, 1, READER, [1, "command", live], [1, phase]]);
        // Readers of positions 0-3 see exactly the pre-phase tuple.
        expect(tuple.slice(0, 4)).toEqual(JSON.parse(legacy!));
        // The phase rides inside the existing attribute; it never adds one.
        const fields = fieldsWith(69);
        const withPhase = withPreviewClientContext(fields, sent);
        const without = withPreviewClientContext(
          fields,
          query(
            [...sent.entries()].filter(
              ([name]) => name !== PREVIEW_TERMINAL_PHASE_PARAM,
            ),
          ),
        );
        expect(Object.keys(withPhase)).toEqual(Object.keys(without));
        expect(withPhase[PREVIEW_CLIENT_CONTEXT_KEY]).toBe(
          JSON.stringify(tuple),
        );
        expect(withPhase[PREVIEW_TERMINAL_INTENT_KEY]).toBe(
          live ? '[1,"multiple_operations"]' : undefined,
        );
      }
  });

  it("is sent only beside a non-fresh browserRequested command source with a closed phase", () => {
    const sent = (
      fresh: boolean,
      mask: number,
      textSource: Parameters<typeof previewCaptureUrl>[5],
    ) =>
      params(
        previewCaptureUrl(ENDPOINT, fresh, mask, READER, false, textSource),
      );
    const omitted = [
      sent(true, 1, command(true, "executing")),
      sent(true, 1, command(false, "awaiting_approval")),
      sent(false, 8, command(true, "executing")),
      sent(false, 9, command(undefined, "executing")),
      sent(false, 1, { ...command(true, "executing"), source: "brief" }),
      sent(false, 1, {
        ...command(false, "reviewing"),
        source: "interactive_brief",
      }),
      sent(false, 1, { ...command(true, "executing"), source: "unavailable" }),
      sent(false, 1, { ...command(true, "executing"), source: undefined }),
      sent(false, 1, command(true, undefined)),
      sent(false, 1, command(true, "PRIVATE_COMMAND")),
      sent(false, 1, command(true, "__proto__")),
      sent(false, 1, command(true, "Executing")),
      sent(false, 1, command(true, `executing${"x".repeat(100_000)}`)),
    ];
    for (const sentQuery of omitted)
      expect(sentQuery.has(PREVIEW_TERMINAL_PHASE_PARAM)).toBe(false);
    // The phase never alters the parameters the existing tuple is built from.
    expect(
      [...sent(false, 1, command(true, "reviewing", "open_only")).entries()]
        .filter(([name]) => name !== PREVIEW_TERMINAL_PHASE_PARAM)
        .map(String),
    ).toEqual(
      [...sent(false, 1, command(true, undefined, "open_only")).entries()].map(
        String,
      ),
    );
  });

  const phase = (value: string): Array<[string, string]> => [
    [PREVIEW_TERMINAL_PHASE_PARAM, value],
  ];
  const source = (value: string): Array<[string, string]> => [
    [PREVIEW_TEXT_SOURCE_PARAM, value],
  ];
  const live = [...group("1"), ...source("1.command.1")];
  const historical = [...group("1"), ...source("1.command.0")];
  it.each([
    ["absent phase", live, []],
    [
      "duplicate phase",
      live,
      [...phase("1.executing"), ...phase("1.executing")],
    ],
    [
      "conflicting duplicate phase",
      historical,
      [...phase("1.reviewing"), ...phase("1.completed")],
    ],
    ["future phase", live, phase("2.executing")],
    ["unversioned phase", historical, phase("executing")],
    ["whitespace phase", live, phase("1.executing ")],
    ["uppercase phase", live, phase("1.Executing")],
    ["forged phase", live, phase("1.PRIVATE_COMMAND")],
    ["prototype phase", historical, phase("__proto__")],
    ["injected phase", live, phase('1.executing"],["PRIVATE_COMMAND')],
    ["oversized phase", live, phase(`1.executing${" ".repeat(10_000)}`)],
    ["fresh live request", [...live, ["fresh", "1"]], phase("1.executing")],
    [
      "fresh historical request",
      [...historical, ["fresh", "1"]],
      phase("1.completed"),
    ],
    ["any fresh key", [...live, ["fresh", "0"]], phase("1.executing")],
    ["absent source", group("1"), phase("1.executing")],
    [
      "brief source",
      [...group("1"), ...source("1.brief.1")],
      phase("1.executing"),
    ],
    [
      "interactive brief source",
      [...group("1"), ...source("1.interactive_brief.0")],
      phase("1.executing"),
    ],
    [
      "unavailable source",
      [...group("1"), ...source("1.unavailable.1")],
      phase("1.executing"),
    ],
    [
      "invalid source",
      [...group("1"), ...source("1.command.true")],
      phase("1.executing"),
    ],
    [
      "duplicate source",
      [...live, ...source("1.command.1")],
      phase("1.executing"),
    ],
    [
      "mask without browserRequested",
      [...group("8"), ...source("1.command.1")],
      phase("1.executing"),
    ],
  ] as Array<[string, Array<[string, string]>, Array<[string, string]>]>)(
    "drops only the phase for a %s",
    (_name, base, extra) => {
      const fields = fieldsWith(3);
      expect(parsePreviewClientContext(query([...base, ...extra]))).toBe(
        parsePreviewClientContext(query(base)),
      );
      const result = withPreviewClientContext(
        fields,
        query([...base, ...extra]),
      );
      expect(result).toEqual(withPreviewClientContext(fields, query(base)));
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|executing|completed/);
    },
  );

  it("never rescues an invalid base", () => {
    expect(
      parsePreviewClientContext(
        query([
          ...group("24"),
          ...source("1.command.1"),
          ...phase("1.executing"),
        ]),
      ),
    ).toBeUndefined();
  });

  it("keeps the four-element tuple and intent if only the phase cannot be read", () => {
    for (const unreadable of [PREVIEW_TERMINAL_PHASE_PARAM, "fresh"]) {
      const real = params(
        previewCaptureUrl(
          ENDPOINT,
          false,
          1,
          READER,
          false,
          command(true, "awaiting_approval", "open_only"),
        ),
      );
      const hostile = {
        getAll: (name: string) => {
          if (name === unreadable) throw new Error("PRIVATE_COOKIE");
          return real.getAll(name);
        },
      } as unknown as URLSearchParams;
      const fields = fieldsWith(3);
      expect(withPreviewClientContext(fields, hostile)).toEqual({
        ...fields,
        [PREVIEW_CLIENT_CONTEXT_KEY]: `[1,1,"${READER}",[1,"command",true]]`,
        [PREVIEW_TERMINAL_INTENT_KEY]: '[1,"open_only"]',
      });
    }
  });
});

describe("bounded field append", () => {
  const fieldsWith = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`field_${index}`, index]),
    );

  it("returns the identical baseline for legacy, invalid or over-budget input", () => {
    const fields = fieldsWith(11);
    expect(withPreviewClientContext(fields, query([]))).toBe(fields);
    expect(withPreviewClientContext(fields, query(group("24")))).toBe(fields);
    const full = fieldsWith(71);
    expect(withPreviewClientContext(full, query(group()))).toBe(full);
    const existing = { ...fields, [PREVIEW_CLIENT_CONTEXT_KEY]: "server" };
    expect(withPreviewClientContext(existing, query(group()))).toBe(existing);
  });

  it("appends one attribute last without mutating the baseline", () => {
    const fields = fieldsWith(70);
    const result = withPreviewClientContext(fields, query(group()));
    expect(Object.keys(fields)).toHaveLength(70);
    expect(Object.keys(result)).toEqual([
      ...Object.keys(fields),
      PREVIEW_CLIENT_CONTEXT_KEY,
    ]);
    expect(result).toMatchObject(fields);
    expect(result[PREVIEW_CLIENT_CONTEXT_KEY]).toBe(`[1,39,"${READER}"]`);
  });

  it("keeps the original fields if the query cannot be read", () => {
    const fields = fieldsWith(3);
    const hostile = {
      getAll: () => {
        throw new Error("PRIVATE_COOKIE");
      },
    } as unknown as URLSearchParams;
    expect(withPreviewClientContext(fields, hostile)).toBe(fields);
  });
});

// All keys available across command-exit stream_status failures.
// The remaining capture keys belong to other stages (decode, bridge, SDK start,
// fresh screenshot).
const COMMAND_EXIT_CAPTURE_KEYS = [
  "capture_stage",
  "capture_error_kind",
  "capture_command_exit_code",
  "capture_precondition_reason",
  "capture_precondition_error",
  "capture_deadline_diagnostic_version",
  "capture_deadline_phase",
  "capture_response_diagnostic_version",
  "capture_response_validation",
  "capture_daemon_socket_queue_version",
  "capture_daemon_socket_pending_count",
  "capture_daemon_socket_held_count",
  "capture_cli_at_prepare_diagnostic_version",
  "capture_cli_at_prepare_status",
  "capture_cli_at_prepare_major",
  "capture_cli_at_prepare_minor",
  "capture_cli_at_prepare_patch",
  "capture_wrapper_receipt_version",
  "capture_wrapper_action",
  "capture_wrapper_phase",
  "capture_wrapper_exit_code",
  "capture_wrapper_session_matches",
  "capture_wrapper_age",
  "capture_wrapper_process_version",
  "capture_wrapper_process_visibility",
  "capture_wrapper_command_version",
  "capture_wrapper_command_class",
  "capture_wrapper_result_version",
  "capture_wrapper_result_scope",
  "capture_wrapper_result",
  "capture_wrapper_result_elapsed",
  "capture_wrapper_history_version",
  "capture_wrapper_history_scope",
  "capture_wrapper_other_cli_completed",
  "capture_wrapper_option_prefix_completed",
  "capture_open_receipt_version",
  "capture_open_receipt_status",
  "capture_open_phase",
  "capture_open_exit_code",
  "capture_open_session_matches",
  "capture_open_age",
  "capture_open_idle_env_version",
  "capture_open_idle_env",
  "capture_daemon_process_version",
  "capture_daemon_pid_status",
  "capture_daemon_process_visibility",
  "capture_open_socket_return_version",
  "capture_open_socket_return_status",
  "capture_open_info_version",
  "capture_open_info_flags",
  "capture_daemon_version_file_version",
  "capture_daemon_version_file_status",
  "capture_daemon_version_file_major",
  "capture_daemon_version_file_minor",
  "capture_daemon_version_file_patch",
  "capture_close_receipt_version",
  "capture_close_receipt_status",
  "capture_close_phase",
  "capture_close_exit_code",
  "capture_close_scope",
  "capture_close_age",
  "capture_close_open_order",
] as const satisfies ReadonlyArray<keyof BrowserCaptureFailureContext>;
const OTHER_STAGE_CAPTURE_KEYS = [
  "capture_frame_decode_version",
  "capture_frame_stdout_size",
  "capture_frame_stdout_shape",
  "capture_frame_parse_error_kind",
  "capture_sdk_command_diagnostic_version",
  "capture_sdk_command_phase",
  "capture_sdk_start_ack_latency",
  "capture_fresh_read_diagnostic_version",
  "capture_fresh_read_phase",
  "capture_fresh_read_error_kind",
  "capture_fresh_read_http_status",
  "capture_fresh_read_type_error_signal",
  "capture_fresh_read_transport_code",
  "capture_screenshot_refusal_version",
  "capture_screenshot_refusal",
] as const satisfies ReadonlyArray<keyof BrowserCaptureFailureContext>;
// Only a stream_status exit-2 missing-socket failure carries these keys, so they
// never coexist with the exit-3 deadline or exit-5 response groups.
const MISSING_SOCKET_CAPTURE_KEYS = [
  "capture_open_socket_directory_v1",
] as const satisfies ReadonlyArray<keyof BrowserCaptureFailureContext>;
// The screenshot write order and status socket comparison are exclusive and
// only a still-started OPEN can carry either field.
const STARTED_OPEN_CAPTURE_KEYS = [
  "capture_open_start_write_order_v1",
  "capture_open_preconnect_held_v1",
] as const satisfies ReadonlyArray<keyof BrowserCaptureFailureContext>;
// This connected-deadline marker is exclusive to completed OPEN and is
// appended by the route only after negotiation and client context.
const COMPLETED_OPEN_OPTIONAL_KEYS = [
  "capture_active_other_command_v1",
] as const satisfies ReadonlyArray<keyof BrowserCaptureFailureContext>;
const EXIT_3_OR_5_CAPTURE_KEYS: ReadonlyArray<string> = [
  "capture_deadline_diagnostic_version",
  "capture_deadline_phase",
  "capture_response_diagnostic_version",
  "capture_response_validation",
  "capture_daemon_socket_queue_version",
  "capture_daemon_socket_pending_count",
  "capture_daemon_socket_held_count",
] satisfies ReadonlyArray<(typeof COMMAND_EXIT_CAPTURE_KEYS)[number]>;
// A connected response deadline excludes exit-2 preconditions and exit-5
// response validation. Model the largest matching context for the new fields.
const NON_DEADLINE_EXIT_CAPTURE_KEYS: ReadonlyArray<string> = [
  "capture_precondition_reason",
  "capture_precondition_error",
  "capture_response_diagnostic_version",
  "capture_response_validation",
] satisfies ReadonlyArray<(typeof COMMAND_EXIT_CAPTURE_KEYS)[number]>;
const DEADLINE_CAPTURE_KEYS = COMMAND_EXIT_CAPTURE_KEYS.filter(
  (key) => !NON_DEADLINE_EXIT_CAPTURE_KEYS.includes(key),
);
// A new capture field must be classified here, so the max fixture stays current.
type UnclassifiedCaptureKey = Exclude<
  keyof BrowserCaptureFailureContext,
  | (typeof COMMAND_EXIT_CAPTURE_KEYS)[number]
  | (typeof MISSING_SOCKET_CAPTURE_KEYS)[number]
  | (typeof STARTED_OPEN_CAPTURE_KEYS)[number]
  | (typeof COMPLETED_OPEN_OPTIONAL_KEYS)[number]
  | (typeof OTHER_STAGE_CAPTURE_KEYS)[number]
  | keyof BrowserBridgeFailureContext
>;
const captureKeysClassified: [UnclassifiedCaptureKey] extends [never]
  ? true
  : false = true;

/** The existing unavailable-GET field order, with a capture context in place. */
const routeFields = (capture: Record<string, unknown>) => ({
  diagnostic_version: 1,
  failure_stage: "capture_frame",
  preview_state: "disconnected",
  failure_kind: "preview_unavailable",
  fresh_requested: true,
  ...capture,
  web_build_commit: SERVER_BUILD,
  request_id: "iad1::qa123-1794060000000-abcdef123456",
  browser_session_id: "0123456789abcdef0123456789abcdef",
  handoff_state: "agent",
  run_active: true,
  trigger_run_id: "run_abcdefghij0123456789",
});
const captureWith = (keys: readonly string[]) =>
  Object.fromEntries(keys.map((key) => [key, 1]));

describe("actual phLogger to OTLP export", () => {
  type Attribute = { key: string; value: Record<string, unknown> };
  const originalFetch = global.fetch;
  const env = {
    POSTHOG_PROJECT_TOKEN: process.env.POSTHOG_PROJECT_TOKEN,
    POSTHOG_LOG_HOST: process.env.POSTHOG_LOG_HOST,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  };
  let fetchMock: jest.Mock;
  let logSpy: jest.SpyInstance;

  beforeAll(() => {
    // Synthetic key and host; only the network boundary is mocked.
    process.env.POSTHOG_PROJECT_TOKEN = "synthetic-test-key";
    process.env.POSTHOG_LOG_HOST = "https://logs.test.invalid";
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(env))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    global.fetch = originalFetch;
    logSpy.mockRestore();
  });

  /** Emit through the real logger and decode the single exported record. */
  const exported = async (fields: Record<string, unknown>, url: string) => {
    fetchMock.mockClear();
    phLogger.info(
      "agent_browser_preview_get_unavailable",
      withPreviewClientContext(
        fields,
        new URL(url, "https://app.example").searchParams,
      ),
    );
    await phLogger.flush();
    expect(logSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0];
    expect(endpoint).toBe("https://logs.test.invalid/i/v1/logs");
    const body = String(init.body);
    for (const canary of CANARIES) expect(body).not.toContain(canary);
    const records = JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords;
    expect(records).toHaveLength(1);
    return records[0].attributes as Attribute[];
  };
  it("exports the finite active EVAL marker through OTLP", async () => {
    const fields = routeFields({
      capture_stage: "stream_status",
      capture_wrapper_command_class: "other",
      capture_open_phase: "completed",
      capture_deadline_phase: "awaiting_response",
      capture_daemon_socket_pending_count: 0,
      capture_daemon_socket_held_count: 3,
    });
    const attributes = await exported(
      {
        ...fields,
        capture_negotiated_deferrals_v1: "open",
        capture_active_other_command_v1: "eval",
      },
      `${ENDPOINT}?fresh=1`,
    );
    expect(attributes).toContainEqual({
      key: "capture_active_other_command_v1",
      value: { stringValue: "eval" },
    });
    expectBaselineSurvives(attributes, fields);
  });

  const withoutTimestamp = (attributes: Attribute[]) =>
    attributes.map(({ key, value }) =>
      key === "timestamp" ? { key, value: "<time>" } : { key, value },
    );
  const expectBaselineSurvives = (
    attributes: Attribute[],
    fields: Record<string, unknown>,
  ) => {
    const byKey = new Map(attributes.map(({ key, value }) => [key, value]));
    for (const [key, value] of Object.entries(fields))
      expect([key, byKey.get(key)]).toEqual([
        key,
        typeof value === "string"
          ? { stringValue: value }
          : typeof value === "boolean"
            ? { boolValue: value }
            : { doubleValue: value },
      ]);
    for (const key of ["service", "environment", "runtime", "event"])
      expect(byKey.has(key)).toBe(true);
    for (const key of ["level", "message", "timestamp"])
      expect(byKey.has(key)).toBe(true);
    expect(attributes.length).toBeLessThanOrEqual(80);
  };
  const privateQuery = (diagnostic: string) =>
    `${ENDPOINT}?fresh=1&cmd=PRIVATE_COMMAND&name=PRIVATE_SESSION_NAME&target=${encodeURIComponent(
      "https://private.example/target",
    )}&note=PRIVATE_NOTE&grant=PRIVATE_GRANT&cookie=PRIVATE_COOKIE${diagnostic}`;

  it("delivers the tuple as one String attribute after the original fields", async () => {
    expect(captureKeysClassified).toBe(true);
    const fields = routeFields(
      captureWith(COMMAND_EXIT_CAPTURE_KEYS.slice(0, 3)),
    );
    const legacy = await exported(fields, `${ENDPOINT}?fresh=1`);
    const url = previewCaptureUrl(ENDPOINT, true, 39, READER.toUpperCase());
    const attributes = await exported(fields, url);
    const tuple = attributes.filter(
      ({ key }) => key === PREVIEW_CLIENT_CONTEXT_KEY,
    );
    expect(tuple).toEqual([
      {
        key: PREVIEW_CLIENT_CONTEXT_KEY,
        value: { stringValue: `[1,39,"${READER}"]` },
      },
    ]);
    // Inserting the one attribute right after the route's own fields leaves
    // every original attribute, value and relative order unchanged.
    const index = attributes.findIndex(({ key }) => key === "trigger_run_id");
    expect(attributes[index + 1].key).toBe(PREVIEW_CLIENT_CONTEXT_KEY);
    expect(
      withoutTimestamp(
        attributes.filter(({ key }) => key !== PREVIEW_CLIENT_CONTEXT_KEY),
      ),
    ).toEqual(withoutTimestamp(legacy));
    // The self-reported reader never replaces the server's own build.
    expect(
      attributes.find(({ key }) => key === "web_build_commit")?.value,
    ).toEqual({ stringValue: SERVER_BUILD });
    expectBaselineSurvives(attributes, fields);
  });

  it("keeps the loaded reader beside a full daemon deadline context", async () => {
    const fields = routeFields(captureWith(DEADLINE_CAPTURE_KEYS));
    expect(Object.keys(fields)).toHaveLength(69);
    const attributes = await exported(
      fields,
      previewCaptureUrl(ENDPOINT, true, 71, READER),
    );
    expect(
      attributes.find(({ key }) => key === PREVIEW_CLIENT_CONTEXT_KEY)?.value,
    ).toEqual({ stringValue: `[1,71,"${READER}"]` });
    expectBaselineSurvives(attributes, fields);
  });

  it("exports the held-connection comparison beside an active OPEN deadline", async () => {
    const fields = routeFields({
      ...captureWith(
        DEADLINE_CAPTURE_KEYS.filter(
          (key) =>
            !key.startsWith("capture_daemon_process_") &&
            key !== "capture_daemon_pid_status" &&
            !key.startsWith("capture_daemon_version_file_") &&
            !key.startsWith("capture_open_socket_return_"),
        ),
      ),
      capture_stage: "stream_status",
      capture_open_phase: "started",
      capture_open_preconnect_held_v1: "present",
    });
    const attributes = await exported(
      fields,
      previewCaptureUrl(ENDPOINT, true, 1, READER, false, {
        source: "command",
        liveSelection: true,
        intent: "plain_open",
      }),
    );
    expect(
      attributes.find(({ key }) => key === "capture_open_preconnect_held_v1")
        ?.value,
    ).toEqual({ stringValue: "present" });
    expect(
      attributes.some(({ key }) => key === PREVIEW_CLIENT_CONTEXT_KEY),
    ).toBe(true);
    expectBaselineSurvives(attributes, fields);
  });

  it("fits the tuple beside the largest missing-socket context with its directory field", async () => {
    const fields = routeFields({
      ...captureWith(
        COMMAND_EXIT_CAPTURE_KEYS.filter(
          (key) => !EXIT_3_OR_5_CAPTURE_KEYS.includes(key),
        ),
      ),
      capture_open_socket_directory_v1: "different_directory",
    });
    expect(Object.keys(fields)).toHaveLength(67);
    const legacy = await exported(fields, `${ENDPOINT}?fresh=1`);
    const attributes = await exported(
      fields,
      previewCaptureUrl(ENDPOINT, true, 71, READER),
    );
    expect(
      attributes.find(({ key }) => key === "capture_open_socket_directory_v1")
        ?.value,
    ).toEqual({ stringValue: "different_directory" });
    expect(
      attributes.find(({ key }) => key === PREVIEW_CLIENT_CONTEXT_KEY)?.value,
    ).toEqual({ stringValue: `[1,71,"${READER}"]` });
    expect(
      withoutTimestamp(
        attributes.filter(({ key }) => key !== PREVIEW_CLIENT_CONTEXT_KEY),
      ),
    ).toEqual(withoutTimestamp(legacy));
    expectBaselineSurvives(attributes, fields);
  });

  it.each([71, 73])(
    "omits the whole tuple for a %i-field baseline, exporting the legacy record",
    async (count) => {
      const deadlineFieldCount = Object.keys(
        routeFields(captureWith(DEADLINE_CAPTURE_KEYS)),
      ).length;
      const extra = OTHER_STAGE_CAPTURE_KEYS.slice(
        0,
        count - deadlineFieldCount,
      );
      const fields = routeFields(
        captureWith([...DEADLINE_CAPTURE_KEYS, ...extra]),
      );
      expect(Object.keys(fields)).toHaveLength(count);
      const legacy = await exported(fields, `${ENDPOINT}?fresh=1`);
      const attributes = await exported(
        fields,
        previewCaptureUrl(ENDPOINT, true, 39, READER),
      );
      expect(
        attributes.some(({ key }) => key === PREVIEW_CLIENT_CONTEXT_KEY),
      ).toBe(false);
      expect(JSON.stringify(attributes)).not.toContain(READER);
      expect(withoutTimestamp(attributes)).toEqual(withoutTimestamp(legacy));
      expectBaselineSurvives(attributes, fields);
    },
  );

  it.each([
    ["absent", ""],
    [
      "invalid",
      `&${PREVIEW_DIAGNOSTIC_VERSION_PARAM}=1&${PREVIEW_ACTIVATION_PARAM}=PRIVATE_COMMAND&${PREVIEW_READER_PARAM}=${READER}`,
    ],
    [
      "future",
      `&${PREVIEW_DIAGNOSTIC_VERSION_PARAM}=2&${PREVIEW_ACTIVATION_PARAM}=1&${PREVIEW_READER_PARAM}=${READER}`,
    ],
    [
      "partial",
      `&${PREVIEW_ACTIVATION_PARAM}=1&${PREVIEW_READER_PARAM}=${READER}`,
    ],
  ])(
    "exports the unchanged record and no private query value for a %s group",
    async (_name, diagnostic) => {
      const fields = routeFields(
        captureWith(COMMAND_EXIT_CAPTURE_KEYS.slice(0, 3)),
      );
      const legacy = await exported(fields, `${ENDPOINT}?fresh=1`);
      const attributes = await exported(fields, privateQuery(diagnostic));
      expect(withoutTimestamp(attributes)).toEqual(withoutTimestamp(legacy));
    },
  );

  it("carries the text source inside the same attribute beside the largest missing-socket context", async () => {
    const fields = routeFields({
      ...captureWith(
        COMMAND_EXIT_CAPTURE_KEYS.filter(
          (key) => !EXIT_3_OR_5_CAPTURE_KEYS.includes(key),
        ),
      ),
      capture_open_socket_directory_v1: "different_directory",
    });
    const legacy = await exported(fields, `${ENDPOINT}?fresh=1`);
    const attributes = await exported(
      fields,
      `${previewCaptureUrl(ENDPOINT, true, 1, READER, false, {
        source: "interactive_brief",
        liveSelection: false,
      })}&cmd=PRIVATE_COMMAND&note=PRIVATE_NOTE`,
    );
    expect(
      attributes.filter(({ key }) => key === PREVIEW_CLIENT_CONTEXT_KEY),
    ).toEqual([
      {
        key: PREVIEW_CLIENT_CONTEXT_KEY,
        value: {
          stringValue: `[1,1,"${READER}",[1,"interactive_brief",false]]`,
        },
      },
    ]);
    expect(attributes).toHaveLength(legacy.length + 1);
    expect(
      withoutTimestamp(
        attributes.filter(({ key }) => key !== PREVIEW_CLIENT_CONTEXT_KEY),
      ),
    ).toEqual(withoutTimestamp(legacy));
    expectBaselineSurvives(attributes, fields);
  });

  it("exports the terminal intent last beside the full daemon deadline context", async () => {
    const fields = routeFields(captureWith(DEADLINE_CAPTURE_KEYS));
    expect(Object.keys(fields)).toHaveLength(69);
    const legacy = await exported(fields, `${ENDPOINT}?fresh=1`);
    const attributes = await exported(
      fields,
      `${previewCaptureUrl(ENDPOINT, true, 1, READER, false, {
        source: "command",
        liveSelection: true,
        intent: "info_with_operation",
      })}&cmd=PRIVATE_COMMAND&note=PRIVATE_NOTE`,
    );
    // Both follow the route's own last field, in order.
    const index = attributes.findIndex(({ key }) => key === "trigger_run_id");
    expect(attributes.slice(index + 1, index + 3)).toEqual([
      {
        key: PREVIEW_CLIENT_CONTEXT_KEY,
        value: { stringValue: `[1,1,"${READER}",[1,"command",true]]` },
      },
      {
        key: PREVIEW_TERMINAL_INTENT_KEY,
        value: { stringValue: '[1,"info_with_operation"]' },
      },
    ]);
    const added = [PREVIEW_CLIENT_CONTEXT_KEY, PREVIEW_TERMINAL_INTENT_KEY];
    expect(
      withoutTimestamp(attributes.filter(({ key }) => !added.includes(key))),
    ).toEqual(withoutTimestamp(legacy));
    expectBaselineSurvives(attributes, fields);
  });

  it("exports the terminal phase inside the existing tuple beside the full daemon deadline context", async () => {
    const fields = routeFields(captureWith(DEADLINE_CAPTURE_KEYS));
    expect(Object.keys(fields)).toHaveLength(69);
    const url = (phase?: string) =>
      `${previewCaptureUrl(ENDPOINT, false, 1, READER, false, {
        source: "command",
        liveSelection: true,
        intent: "multiple_operations",
        phase,
      })}&cmd=PRIVATE_COMMAND&note=PRIVATE_NOTE`;
    const withoutPhase = await exported(fields, url());
    const attributes = await exported(fields, url("awaiting_approval"));
    const context = (list: Attribute[]) =>
      list.find(({ key }) => key === PREVIEW_CLIENT_CONTEXT_KEY)?.value;
    expect(context(attributes)).toEqual({
      stringValue: `[1,1,"${READER}",[1,"command",true],[1,"awaiting_approval"]]`,
    });
    // Same keys, order and values; only the tuple string gained its element.
    const others = (list: Attribute[]) =>
      withoutTimestamp(
        list.filter(({ key }) => key !== PREVIEW_CLIENT_CONTEXT_KEY),
      );
    expect(attributes.map(({ key }) => key)).toEqual(
      withoutPhase.map(({ key }) => key),
    );
    expect(others(attributes)).toEqual(others(withoutPhase));
    expect(
      attributes.find(({ key }) => key === PREVIEW_TERMINAL_INTENT_KEY)?.value,
    ).toEqual({ stringValue: '[1,"multiple_operations"]' });
    expectBaselineSurvives(attributes, fields);
  });

  it("exports the other-only kind last only where it adds no displacement", async () => {
    const refined = `${previewCaptureUrl(ENDPOINT, true, 1, READER, false, {
      source: "command",
      liveSelection: true,
      intent: agentBrowserPreviewIntent("agent-browser PRIVATE_COMMAND"),
    })}&cmd=PRIVATE_COMMAND&note=PRIVATE_NOTE`;
    const unrefined = previewCaptureUrl(ENDPOINT, true, 1, READER, false, {
      source: "command",
      liveSelection: true,
      intent: "other_only",
    });
    const added = [
      PREVIEW_CLIENT_CONTEXT_KEY,
      PREVIEW_TERMINAL_INTENT_KEY,
      PREVIEW_TERMINAL_OTHER_KIND_KEY,
    ];

    // The largest missing-socket context still delivers the refinement.
    const roomy = routeFields({
      ...captureWith(
        COMMAND_EXIT_CAPTURE_KEYS.filter(
          (key) => !EXIT_3_OR_5_CAPTURE_KEYS.includes(key),
        ),
      ),
      capture_open_socket_directory_v1: "different_directory",
    });
    expect(Object.keys(roomy)).toHaveLength(67);
    const legacy = await exported(roomy, `${ENDPOINT}?fresh=1`);
    const attributes = await exported(roomy, refined);
    const index = attributes.findIndex(({ key }) => key === "trigger_run_id");
    expect(attributes.slice(index + 1, index + 4)).toEqual([
      {
        key: PREVIEW_CLIENT_CONTEXT_KEY,
        value: { stringValue: `[1,1,"${READER}",[1,"command",true]]` },
      },
      {
        key: PREVIEW_TERMINAL_INTENT_KEY,
        value: { stringValue: '[1,"other_only"]' },
      },
      {
        key: PREVIEW_TERMINAL_OTHER_KIND_KEY,
        value: { stringValue: '[1,"unrecognized_action"]' },
      },
    ]);
    expect(
      withoutTimestamp(attributes.filter(({ key }) => !added.includes(key))),
    ).toEqual(withoutTimestamp(legacy));
    expectBaselineSurvives(attributes, roomy);

    // The full deadline context exports exactly the unrefined other_only record.
    const full = routeFields(captureWith(DEADLINE_CAPTURE_KEYS));
    expect(Object.keys(full)).toHaveLength(69);
    const fullRefined = await exported(full, refined);
    expect(withoutTimestamp(fullRefined)).toEqual(
      withoutTimestamp(await exported(full, unrefined)),
    );
    expectBaselineSurvives(fullRefined, full);
  });

  it("omits the tuple and its add-on together at exhausted headroom", async () => {
    const deadlineFieldCount = Object.keys(
      routeFields(captureWith(DEADLINE_CAPTURE_KEYS)),
    ).length;
    const fields = routeFields(
      captureWith([
        ...DEADLINE_CAPTURE_KEYS,
        ...OTHER_STAGE_CAPTURE_KEYS.slice(0, 71 - deadlineFieldCount),
      ]),
    );
    expect(Object.keys(fields)).toHaveLength(71);
    const legacy = await exported(fields, `${ENDPOINT}?fresh=1`);
    const attributes = await exported(
      fields,
      previewCaptureUrl(ENDPOINT, true, 1, READER, false, {
        source: "brief",
        liveSelection: true,
      }),
    );
    expect(JSON.stringify(attributes)).not.toContain("brief");
    expect(withoutTimestamp(attributes)).toEqual(withoutTimestamp(legacy));
  });

  it("keeps unrelated private values out while a valid group is delivered", async () => {
    const fields = routeFields(
      captureWith(COMMAND_EXIT_CAPTURE_KEYS.slice(0, 3)),
    );
    const attributes = await exported(
      fields,
      privateQuery(
        `&${PREVIEW_DIAGNOSTIC_VERSION_PARAM}=1&${PREVIEW_ACTIVATION_PARAM}=33&${PREVIEW_READER_PARAM}=unknown`,
      ),
    );
    expect(
      attributes.find(({ key }) => key === PREVIEW_CLIENT_CONTEXT_KEY)?.value,
    ).toEqual({ stringValue: '[1,33,"unknown"]' });
  });
});
