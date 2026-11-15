import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  classifyServerActionUnavailable,
  getServerActionBuildContext,
  sanitizeServerActionClientContextEvent,
} from "../server-action-privacy";

const REFERENCE = "0a".repeat(21);
const NEXT_CLIENT_MESSAGE = `Server Action "${REFERENCE}" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action`;
const SERVER_MESSAGE = `Failed to find Server Action "${REFERENCE}". This request might be from an older or newer deployment.\nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action`;

describe("classifyServerActionUnavailable", () => {
  it("recognizes only the two unavailable-action message families", () => {
    expect(
      classifyServerActionUnavailable(new Error(NEXT_CLIENT_MESSAGE)),
    ).toEqual({
      matched_pattern: "next_unrecognized_action_message",
      reference_shape: "hex42",
    });
    expect(classifyServerActionUnavailable(new Error(SERVER_MESSAGE))).toEqual({
      matched_pattern: "server_action_missing_message",
      reference_shape: "hex42",
    });
    // Browser ErrorEvent messages carry an "Uncaught" prefix.
    expect(
      classifyServerActionUnavailable(`Uncaught Error: ${NEXT_CLIENT_MESSAGE}`),
    ).toEqual({
      matched_pattern: "next_unrecognized_action_message",
      reference_shape: "hex42",
    });
    expect(
      classifyServerActionUnavailable({
        message:
          "Failed to find Server Action. This request might be from an older or newer deployment.",
      }),
    ).toEqual({
      matched_pattern: "server_action_missing_message",
      reference_shape: "other_or_unavailable",
    });

    for (const unrelated of [
      new Error("Failed to fetch"),
      new Error("ChunkLoadError: Loading chunk 12 failed."),
      { message: "This request might be from an older or newer deployment." },
      "https://nextjs.org/docs/messages/failed-to-find-server-action",
      "Failed to find Server Action",
      undefined,
      null,
      42,
    ]) {
      expect(classifyServerActionUnavailable(unrelated)).toBeNull();
    }
  });

  it("reports reference shape without treating build-commit width as an action reference", () => {
    for (const reference of [
      "a".repeat(40),
      "a".repeat(43),
      `${"g".repeat(2)}${"a".repeat(40)}`,
      "",
    ]) {
      expect(
        classifyServerActionUnavailable(
          `Server Action "${reference}" was not found on the server`,
        )?.reference_shape,
      ).toBe("other_or_unavailable");
    }
    expect(
      classifyServerActionUnavailable(
        `Server Action "${"AB".repeat(21)}" was not found on the server`,
      )?.reference_shape,
    ).toBe("hex42");
  });

  it("reads only a bounded own data message and fails closed on hostile values", () => {
    const getter = jest.fn(() => NEXT_CLIENT_MESSAGE);
    const withGetter = Object.defineProperty({}, "message", { get: getter });
    const toString = jest.fn(() => NEXT_CLIENT_MESSAGE);
    const cyclic: Record<string, unknown> = {
      cause: new Error(SERVER_MESSAGE),
    };
    cyclic.self = cyclic;
    const hostileProxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("blocked");
        },
      },
    );

    for (const value of [
      withGetter,
      { toString },
      cyclic,
      Object.create({ message: NEXT_CLIENT_MESSAGE }),
      { message: { text: NEXT_CLIENT_MESSAGE } },
      { stack: NEXT_CLIENT_MESSAGE },
      hostileProxy,
      `${NEXT_CLIENT_MESSAGE}${" ".repeat(2_048)}`,
      new Error(`${SERVER_MESSAGE}${" ".repeat(2_048)}`),
    ]) {
      expect(classifyServerActionUnavailable(value)).toBeNull();
    }
    expect(getter).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
  });
});

describe("getServerActionBuildContext", () => {
  const originalBuild = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
  afterEach(() => {
    if (originalBuild === undefined) {
      delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
    } else {
      process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = originalBuild;
    }
  });

  it("accepts only a 40-hex compiled commit", () => {
    process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "ABCDEF0123".repeat(4);
    expect(getServerActionBuildContext()).toEqual({
      build_state: "measured",
      hackerai_frontend_build_commit: "abcdef0123".repeat(4),
    });
    for (const invalid of ["a".repeat(42), "a".repeat(39), "z".repeat(40)]) {
      process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = invalid;
      expect(getServerActionBuildContext()).toEqual({
        build_state: "unavailable",
      });
    }
    delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
    expect(getServerActionBuildContext()).toEqual({
      build_state: "unavailable",
    });
  });
});

describe("sanitizeServerActionClientContextEvent", () => {
  const OWNER = "user_01HZY3K8Q2W";
  const TOKEN = "phc_project_key";
  const EVENT_UUID = "0193a5b2-7c41-7a10-8f00-1234567890ab";
  const expected = () => ({ owner: OWNER, token: TOKEN });
  const transport = {
    token: TOKEN,
    distinct_id: OWNER,
    $session_id: "0193a5b2-7c41-7a10-8f00-aaaaaaaaaaaa",
    $window_id: "0193a5b2-7c41-7a10-8f00-bbbbbbbbbbbb",
    $lib: "web",
    $lib_version: "1.447.5",
    $is_identified: true,
    $process_person_profile: true,
  };
  const local = {
    server_action_client_diagnostic_version: 1,
    caller: "billing_renewal_recovery",
    matched_pattern: "server_action_missing_message",
    reference_shape: "hex42",
    recovery_decision: "locally_handled_no_reload",
    build_state: "measured",
    hackerai_frontend_build_commit: "a".repeat(40),
    attempt_denominator_kind: "caller_settled_prefix",
    caller_settled_attempt_count: 3,
    caller_recognized_rejection_count: 1,
  };
  const global = {
    server_action_client_diagnostic_version: 1,
    caller: "global_unhandled_rejection",
    matched_pattern: "next_unrecognized_action_message",
    reference_shape: "other_or_unavailable",
    recovery_decision: "cooldown_skipped",
    build_state: "unavailable",
    attempt_denominator_kind: "unmeasured",
  };
  const sanitize = (properties: Record<string, unknown>) =>
    sanitizeServerActionClientContextEvent(
      {
        event: "server_action_client_context",
        properties: { distinct_id: OWNER, ...properties },
      },
      expected,
    );

  it("rebuilds the event from validated schema and transport fields after enrichment", () => {
    const timestamp = Object.assign(new Date(1_794_094_000_000), {
      private_field: "private",
      toJSON: () => "private",
    });
    const sanitized = sanitizeServerActionClientContextEvent(
      {
        uuid: EVENT_UUID,
        event: "server_action_client_context",
        properties: {
          ...transport,
          ...local,
          $current_url: "https://hackerai.co/c/private?token=private",
          $referrer: "https://target.test/private",
          $pathname: "/private",
          utm_campaign: "private",
          registered_content: "private",
          consent: "private",
          stripe_invoice_id: "private",
          amount: "private",
          error: "private",
          $user_agent: "private",
          $set: { email: "private" },
          $set_once: { first: "private" },
        },
        timestamp,
        $set: { email: "private" },
        $set_once: { first: "private" },
        $unset: ["private"],
        private_top_level: "private",
      },
      expected,
    );
    expect(sanitized).toEqual({
      uuid: EVENT_UUID,
      event: "server_action_client_context",
      properties: { ...transport, ...local },
      timestamp: new Date(1_794_094_000_000),
    });
    expect(Object.keys(sanitized!)).toEqual([
      "uuid",
      "event",
      "properties",
      "timestamp",
    ]);
    expect(JSON.stringify(sanitized)).not.toContain("private");

    expect(
      sanitize({
        ...local,
        attempt_denominator_kind: "unmeasured",
        caller_settled_attempt_count: 10_001,
      })?.properties,
    ).toEqual({
      distinct_id: OWNER,
      ...Object.fromEntries(
        Object.entries(local).filter(
          ([key]) =>
            key !== "caller_settled_attempt_count" &&
            key !== "caller_recognized_rejection_count",
        ),
      ),
      attempt_denominator_kind: "unmeasured",
    });
  });

  it("omits malformed optional transport and envelope values", () => {
    const sanitized = sanitizeServerActionClientContextEvent(
      {
        uuid: "https://target.test/private",
        event: "server_action_client_context",
        properties: {
          ...global,
          distinct_id: OWNER,
          token: "phc_other_project",
          $session_id: "https://target.test/private",
          $window_id: "private@example.test",
          $lib: "https://target.test/private",
          $lib_version: "x".repeat(200),
          $is_identified: "true",
        },
        timestamp: { getTime: () => 1 },
      },
      expected,
    );
    expect(sanitized).toEqual({
      event: "server_action_client_context",
      properties: { distinct_id: OWNER, ...global },
    });
  });

  it("never invokes accessors and fails closed on hostile target values", () => {
    const accessor = jest.fn(() => "private");
    const withAccessors = {
      event: "server_action_client_context",
      properties: Object.defineProperties(
        { ...transport, ...global },
        {
          $current_url: { get: accessor, enumerable: true },
          $session_id: { get: accessor, enumerable: true },
        },
      ),
      timestamp: new Proxy(new Date(0), { get: accessor }),
    };
    Object.defineProperty(withAccessors, "uuid", {
      get: accessor,
      enumerable: true,
    });
    const sanitized = sanitizeServerActionClientContextEvent(
      withAccessors,
      expected,
    );
    expect(sanitized).toEqual({
      event: "server_action_client_context",
      properties: {
        ...Object.fromEntries(
          Object.entries(transport).filter(([key]) => key !== "$session_id"),
        ),
        ...global,
      },
    });

    for (const hostile of [
      Object.defineProperty({ properties: global }, "event", {
        get: accessor,
      }),
      {
        event: "server_action_client_context",
        properties: Object.defineProperty(
          { ...transport, ...global },
          "caller",
          { get: accessor, enumerable: true },
        ),
      },
      {
        event: "server_action_client_context",
        properties: new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error("blocked");
            },
          },
        ),
      },
      { event: "server_action_client_context", properties: [global] },
    ]) {
      expect(sanitizeServerActionClientContextEvent(hostile, expected)).toBe(
        null,
      );
    }
    expect(accessor).not.toHaveBeenCalled();
  });

  it.each<[string, { owner: string | null; token: string | undefined }]>([
    ["no current owner", { owner: null, token: TOKEN }],
    ["a different current owner", { owner: "user_other", token: TOKEN }],
    ["an email-shaped owner", { owner: "person@example.test", token: TOKEN }],
  ])("drops a target event with %s", (_name, context) => {
    expect(
      sanitizeServerActionClientContextEvent(
        {
          event: "server_action_client_context",
          properties: { ...transport, ...global },
        },
        () => context,
      ),
    ).toBeNull();
  });

  it("drops a target event when the owner cannot be resolved", () => {
    expect(
      sanitizeServerActionClientContextEvent(
        {
          event: "server_action_client_context",
          properties: { ...transport, ...global },
        },
        () => {
          throw new Error("identity unavailable");
        },
      ),
    ).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    [
      "a missing version",
      { ...local, server_action_client_diagnostic_version: undefined },
    ],
    [
      "a string version",
      { ...local, server_action_client_diagnostic_version: "1" },
    ],
    [
      "a future version",
      { ...local, server_action_client_diagnostic_version: 2 },
    ],
    ["an unknown caller", { ...local, caller: "billing_checkout" }],
    [
      "a local reload decision",
      { ...local, recovery_decision: "reload_requested" },
    ],
    [
      "a global local decision",
      { ...global, recovery_decision: "locally_handled_no_reload" },
    ],
    [
      "a global denominator",
      {
        ...global,
        attempt_denominator_kind: "caller_settled_prefix",
        caller_settled_attempt_count: 1,
        caller_recognized_rejection_count: 1,
      },
    ],
    [
      "a missing denominator",
      { ...local, attempt_denominator_kind: undefined },
    ],
    ["an over-limit count", { ...local, caller_settled_attempt_count: 10_001 }],
    [
      "more rejections than settlements",
      { ...local, caller_recognized_rejection_count: 4 },
    ],
    ["a fractional count", { ...local, caller_settled_attempt_count: 1.5 }],
    ["a string count", { ...local, caller_settled_attempt_count: "3" }],
    [
      "a 42-hex build commit",
      { ...local, hackerai_frontend_build_commit: "a".repeat(42) },
    ],
    [
      "an uppercase build commit",
      { ...local, hackerai_frontend_build_commit: "A".repeat(40) },
    ],
    [
      "an unavailable build with a commit",
      { ...global, hackerai_frontend_build_commit: "a".repeat(40) },
    ],
    [
      "an unknown pattern",
      { ...local, matched_pattern: "older_or_newer_deployment" },
    ],
    ["a raw reference", { ...local, reference_shape: REFERENCE }],
  ])("drops a target event with %s", (_name, properties) => {
    expect(sanitize(properties)).toBeNull();
  });

  it("drops target events without properties and leaves other events untouched", () => {
    const resolve = jest.fn(expected);
    expect(
      sanitizeServerActionClientContextEvent(
        { event: "server_action_client_context" },
        resolve,
      ),
    ).toBeNull();
    expect(sanitizeServerActionClientContextEvent(null, resolve)).toBeNull();
    resolve.mockClear();
    const ordinary = {
      event: "ordinary_event",
      properties: { $current_url: "https://hackerai.co/c/1" },
      $set: { email: "retained" },
    };
    expect(sanitizeServerActionClientContextEvent(ordinary, resolve)).toBe(
      ordinary,
    );
    // Identity is resolved only for the target event.
    expect(resolve).not.toHaveBeenCalled();
    expect(ordinary).toEqual({
      event: "ordinary_event",
      properties: { $current_url: "https://hackerai.co/c/1" },
      $set: { email: "retained" },
    });
  });
});
