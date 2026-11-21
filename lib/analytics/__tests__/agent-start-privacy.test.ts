import { describe, expect, it, jest } from "@jest/globals";
import {
  AGENT_PARTIAL_SAVE_BODY_BUCKETS,
  AGENT_PARTIAL_SAVE_HTTP413_DIAGNOSTIC_EVENT,
  AGENT_START_BODY_MAX_UTF8_BYTES,
  AGENT_START_HTTP413_DIAGNOSTIC_EVENT,
  sanitizeAgentHttp413DiagnosticEvent,
} from "../agent-start-privacy";

const owner = "user_01ABC";
const expected = () => ({ owner, token: "phc_test" });
const eventUuid = "0193a5b2-7c41-7a10-8f00-aaaaaaaaaaaa";
const requestId = "iad1::fra1::8x2kq-1794094000000-0123456789ab";
const BUILD = "abcdef0123".repeat(4);
const transport = {
  token: "phc_test",
  distinct_id: owner,
  $session_id: "0193a5b2-7c41-7a10-8f00-bbbbbbbbbbbb",
  $window_id: "0193a5b2-7c41-7a10-8f00-cccccccccccc",
  $lib: "web",
  $lib_version: "1.447.5",
  $is_identified: true,
};
const diagnostic = {
  agent_start_http413_diagnostic_version: 1,
  http_status: 413,
  request_body_state: "measured",
  request_body_utf8_bytes: 4_718_592,
  app_rejection_marker_state: "absent",
  vercel_error_state: "known",
  platform_request_id_state: "valid",
  platform_request_id: requestId,
  build_state: "measured",
  hackerai_frontend_build_commit: BUILD,
  attempt_denominator_kind: "unmeasured",
};
// What the SDK, super properties and native capture can add after capture.
const enriched = (
  properties: Record<string, unknown>,
  event: string = AGENT_START_HTTP413_DIAGNOSTIC_EVENT,
) => ({
  uuid: eventUuid,
  event,
  properties: {
    ...properties,
    $current_url: "https://hackerai.co/c/PRIVATE_CHAT",
    $pathname: "/c/PRIVATE_CHAT",
    $referrer: "https://PRIVATE.example/",
    $set: { email: "PRIVATE_EMAIL" },
    $raw_user_agent: "PRIVATE_UA",
    subscription: "PRIVATE_PLAN",
    native_app_version: "0.7.9",
    native_platform: "darwin",
    body: '{"messages":[{"text":"PRIVATE_PROMPT"}]}',
    error: "PRIVATE_ERROR_MESSAGE",
    response_url: "https://PRIVATE.vercel.app/api/agent",
  },
  timestamp: new Date(1_794_094_000_000),
  $set_once: { $initial_referrer: "PRIVATE" },
});
const sanitize = (properties: Record<string, unknown>) =>
  sanitizeAgentHttp413DiagnosticEvent(enriched(properties), expected);

describe("sanitizeAgentHttp413DiagnosticEvent for Agent start", () => {
  it("rebuilds the owner's event from validated fields only", () => {
    const sanitized = sanitize({ ...transport, ...diagnostic });
    expect(sanitized).toEqual({
      uuid: eventUuid,
      event: AGENT_START_HTTP413_DIAGNOSTIC_EVENT,
      properties: { ...transport, ...diagnostic },
      timestamp: new Date(1_794_094_000_000),
    });
    expect(JSON.stringify(sanitized)).not.toContain("PRIVATE");
    expect(sanitized?.properties).not.toHaveProperty("native_app_version");
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      "an unmeasured body and unreadable headers",
      {
        request_body_state: "unmeasured_budget",
        request_body_utf8_bytes: undefined,
        app_rejection_marker_state: "unreadable",
        vercel_error_state: "unreadable",
        platform_request_id_state: "unreadable",
        platform_request_id: undefined,
      },
      {},
    ],
    [
      "a native capture's null commit for an unavailable build",
      { build_state: "unavailable", hackerai_frontend_build_commit: null },
      { build_state: "unavailable" },
    ],
    ["an empty measured body", { request_body_utf8_bytes: 0 }, {}],
    [
      "the derived maximum byte count",
      { request_body_utf8_bytes: AGENT_START_BODY_MAX_UTF8_BYTES },
      {},
    ],
  ])("keeps %s", (_name, override, normalized) => {
    const input = { ...diagnostic, ...override };
    const sanitized = sanitize({ ...transport, ...input });
    const expectedSchema = Object.fromEntries(
      Object.entries({ ...input, ...normalized }).filter(
        ([key, value]) =>
          value !== undefined &&
          !(key === "hackerai_frontend_build_commit" && value === null),
      ),
    );
    expect(sanitized?.properties).toEqual({ ...transport, ...expectedSchema });
  });

  it.each<[string, Record<string, unknown>]>([
    ["another version", { agent_start_http413_diagnostic_version: 2 }],
    ["another status", { http_status: 414 }],
    ["an unknown body state", { request_body_state: "truncated" }],
    ["a measured body without bytes", { request_body_utf8_bytes: undefined }],
    ["bytes as text", { request_body_utf8_bytes: "4718592" }],
    ["fractional bytes", { request_body_utf8_bytes: 1.5 }],
    ["negative bytes", { request_body_utf8_bytes: -1 }],
    [
      "bytes above the derived maximum",
      { request_body_utf8_bytes: AGENT_START_BODY_MAX_UTF8_BYTES + 1 },
    ],
    [
      "bytes for an unmeasured body",
      { request_body_state: "unmeasured_unsupported" },
    ],
    ["raw marker text", { app_rejection_marker_state: "PRIVATE" }],
    [
      "the Vercel code copied as text",
      { vercel_error_state: "FUNCTION_PAYLOAD_TOO_LARGE" },
    ],
    [
      "a valid state with an invalid ID",
      { platform_request_id: "https://PRIVATE.example/" },
    ],
    [
      "an ID beside a non-valid state",
      { platform_request_id_state: "invalid" },
    ],
    [
      "an uppercase build",
      { hackerai_frontend_build_commit: BUILD.toUpperCase() },
    ],
    ["a commit beside an unavailable build", { build_state: "unavailable" }],
    ["a measured denominator", { attempt_denominator_kind: "caller_prefix" }],
  ])("drops %s", (_name, override) => {
    expect(sanitize({ ...transport, ...diagnostic, ...override })).toBeNull();
  });

  it("drops a schema field accessor without running it", () => {
    const getter = jest.fn(() => 413);
    const properties = Object.defineProperty(
      { ...transport, ...diagnostic },
      "http_status",
      { get: getter, enumerable: true },
    );
    expect(
      sanitizeAgentHttp413DiagnosticEvent(
        { event: AGENT_START_HTTP413_DIAGNOSTIC_EVENT, properties },
        expected,
      ),
    ).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it("drops a queued event captured for another distinct ID", () => {
    expect(
      sanitize({ ...transport, ...diagnostic, distinct_id: "user_other" }),
    ).toBeNull();
  });

  it.each<[string, () => { owner: string | null; token: string }]>([
    ["no committed owner", () => ({ owner: null, token: "phc_test" })],
    ["a different current owner", () => ({ owner: "user_other", token: "x" })],
    ["a malformed owner", () => ({ owner: "a@b.test", token: "phc_test" })],
    [
      "a failing owner read",
      () => {
        throw new Error("identity unavailable");
      },
    ],
  ])("drops the event for %s", (_name, resolve) => {
    expect(
      sanitizeAgentHttp413DiagnosticEvent(
        enriched({ ...transport, ...diagnostic }),
        resolve,
      ),
    ).toBeNull();
  });

  it("drops a mismatched token and malformed envelopes, and leaves other events untouched", () => {
    expect(
      sanitize({ ...transport, ...diagnostic, token: "phc_other" })?.properties,
    ).not.toHaveProperty("token");
    expect(
      sanitizeAgentHttp413DiagnosticEvent(
        { event: AGENT_START_HTTP413_DIAGNOSTIC_EVENT, properties: [] },
        expected,
      ),
    ).toBeNull();
    expect(
      sanitizeAgentHttp413DiagnosticEvent(
        Object.defineProperty({}, "event", {
          get: () => AGENT_START_HTTP413_DIAGNOSTIC_EVENT,
        }),
        expected,
      ),
    ).toBeNull();
    const hostile = new Proxy(
      { event: AGENT_START_HTTP413_DIAGNOSTIC_EVENT },
      {
        getOwnPropertyDescriptor() {
          throw new Error("blocked");
        },
      },
    );
    expect(sanitizeAgentHttp413DiagnosticEvent(hostile, expected)).toBeNull();

    const resolve = jest.fn(expected);
    for (const name of ["$exception", "constructor", "__proto__"]) {
      const other = { event: name, properties: { body: "kept" } };
      expect(sanitizeAgentHttp413DiagnosticEvent(other, resolve)).toBe(other);
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("sanitizeAgentHttp413DiagnosticEvent for Agent partial save", () => {
  const partialSave = {
    agent_partial_save_http413_diagnostic_version: 1,
    http_status: 413,
    request_body_utf8_bucket: "gt_4_lte_4_5_mib",
    vercel_error_state: "known",
    platform_request_id_state: "valid",
    platform_request_id: requestId,
    build_state: "measured",
    hackerai_frontend_build_commit: BUILD,
  };
  const sanitizePartialSave = (
    properties: Record<string, unknown>,
    resolve: () => { owner: string | null; token: string } = expected,
  ) =>
    sanitizeAgentHttp413DiagnosticEvent(
      enriched(properties, AGENT_PARTIAL_SAVE_HTTP413_DIAGNOSTIC_EVENT),
      resolve,
    );

  it("rebuilds the owner's event and drops SDK URLs and request content", () => {
    const sanitized = sanitizePartialSave({
      ...transport,
      ...partialSave,
      // Values a malformed capture might carry; none has a schema slot.
      request_body_utf8_bytes: 4_500_000,
      chat_id: "PRIVATE_CHAT",
      trigger_run_id: "run_PRIVATE",
      run_correlation_token: "PRIVATE_TOKEN",
      message_id: "PRIVATE_MESSAGE",
      response_body: "PRIVATE_RESPONSE",
      headers: { "x-vercel-id": "PRIVATE" },
      app_rejection_marker_state: "known",
      attempt_denominator_kind: "unmeasured",
    });
    expect(sanitized).toEqual({
      uuid: eventUuid,
      event: AGENT_PARTIAL_SAVE_HTTP413_DIAGNOSTIC_EVENT,
      properties: { ...transport, ...partialSave },
      timestamp: new Date(1_794_094_000_000),
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/PRIVATE|4500000|https?:/);
  });

  it.each(AGENT_PARTIAL_SAVE_BODY_BUCKETS)("keeps the %s bucket", (bucket) => {
    expect(
      sanitizePartialSave({
        ...transport,
        ...partialSave,
        request_body_utf8_bucket: bucket,
      })?.properties,
    ).toMatchObject({ request_body_utf8_bucket: bucket });
  });

  it("keeps absent headers and an unavailable build", () => {
    expect(
      sanitizePartialSave({
        ...transport,
        ...partialSave,
        vercel_error_state: "absent",
        platform_request_id_state: "absent",
        platform_request_id: undefined,
        build_state: "unavailable",
        hackerai_frontend_build_commit: null,
      })?.properties,
    ).toEqual({
      ...transport,
      agent_partial_save_http413_diagnostic_version: 1,
      http_status: 413,
      request_body_utf8_bucket: "gt_4_lte_4_5_mib",
      vercel_error_state: "absent",
      platform_request_id_state: "absent",
      build_state: "unavailable",
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["another version", { agent_partial_save_http413_diagnostic_version: 2 }],
    ["another status", { http_status: 400 }],
    ["a missing bucket", { request_body_utf8_bucket: undefined }],
    ["an exact size as the bucket", { request_body_utf8_bucket: 4_718_592 }],
    ["an unknown bucket", { request_body_utf8_bucket: "gt_16_mib" }],
    [
      "the Vercel code copied as text",
      { vercel_error_state: "FUNCTION_PAYLOAD_TOO_LARGE" },
    ],
    [
      "a valid state with an invalid ID",
      { platform_request_id: "https://PRIVATE.example/" },
    ],
    ["an ID beside a non-valid state", { platform_request_id_state: "absent" }],
    [
      "an uppercase build",
      { hackerai_frontend_build_commit: BUILD.toUpperCase() },
    ],
    ["a commit beside an unavailable build", { build_state: "unavailable" }],
  ])("drops %s", (_name, override) => {
    expect(
      sanitizePartialSave({ ...transport, ...partialSave, ...override }),
    ).toBeNull();
  });

  it("never accepts one diagnostic's schema under the other's name", () => {
    expect(sanitizePartialSave({ ...transport, ...diagnostic })).toBeNull();
    expect(sanitize({ ...transport, ...partialSave })).toBeNull();
  });

  it.each<[string, () => { owner: string | null; token: string }]>([
    ["no committed owner", () => ({ owner: null, token: "phc_test" })],
    ["a different current owner", () => ({ owner: "user_other", token: "x" })],
    [
      "a failing owner read",
      () => {
        throw new Error("identity unavailable");
      },
    ],
  ])("drops the event for %s", (_name, resolve) => {
    expect(
      sanitizePartialSave({ ...transport, ...partialSave }, resolve),
    ).toBeNull();
  });

  it("drops a queued event captured for another distinct ID", () => {
    expect(
      sanitizePartialSave({
        ...transport,
        ...partialSave,
        distinct_id: "user_other",
      }),
    ).toBeNull();
  });

  it("drops a schema field accessor without running it", () => {
    const getter = jest.fn(() => "lte_4_mib");
    const properties = Object.defineProperty(
      { ...transport, ...partialSave },
      "request_body_utf8_bucket",
      { get: getter, enumerable: true },
    );
    expect(
      sanitizeAgentHttp413DiagnosticEvent(
        { event: AGENT_PARTIAL_SAVE_HTTP413_DIAGNOSTIC_EVENT, properties },
        expected,
      ),
    ).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
});
