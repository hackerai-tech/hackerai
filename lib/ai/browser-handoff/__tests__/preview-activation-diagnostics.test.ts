import type { BrowserBridgeFailureContext } from "../bridge-program";
import {
  PREVIEW_ACTIVATION_PARAM,
  PREVIEW_CLIENT_CONTEXT_KEY,
  PREVIEW_DIAGNOSTIC_VERSION_PARAM,
  PREVIEW_READER_PARAM,
  parsePreviewClientContext,
  previewActivationMask,
  previewCaptureUrl,
  withPreviewClientContext,
} from "../preview-activation-diagnostics";
import type { BrowserCaptureFailureContext } from "../server";
import { phLogger } from "@/lib/posthog/server";

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

// Every capture key a single command-exit stream_status failure can record.
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
// A new capture field must be classified here, so the max fixture stays current.
type UnclassifiedCaptureKey = Exclude<
  keyof BrowserCaptureFailureContext,
  | (typeof COMMAND_EXIT_CAPTURE_KEYS)[number]
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

  it("fits the tuple beside the largest single-stage capture context", async () => {
    const fields = routeFields(captureWith(COMMAND_EXIT_CAPTURE_KEYS));
    expect(Object.keys(fields)).toHaveLength(70);
    const attributes = await exported(
      fields,
      previewCaptureUrl(ENDPOINT, true, 71, READER),
    );
    expect(
      attributes.find(({ key }) => key === PREVIEW_CLIENT_CONTEXT_KEY)?.value,
    ).toEqual({ stringValue: `[1,71,"${READER}"]` });
    expectBaselineSurvives(attributes, fields);
  });

  it.each([71, 73])(
    "omits the whole tuple for a %i-field baseline, exporting the legacy record",
    async (count) => {
      const extra = OTHER_STAGE_CAPTURE_KEYS.slice(0, count - 70);
      const fields = routeFields(
        captureWith([...COMMAND_EXIT_CAPTURE_KEYS, ...extra]),
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
