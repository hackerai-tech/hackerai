import { spawnSync } from "node:child_process";
import { createTriggerRunReadDiagnostics } from "../trigger-run-read-diagnostics";
import {
  serviceTransportObserverKey,
  serviceTransportRuntime,
  type ServiceTransportObservation,
} from "../../db/service-transport-observation";

const originalApiURL = process.env.TRIGGER_API_URL;
const installObserver = (
  observation: Partial<ServiceTransportObservation> = {},
) => {
  const observer = jest.fn((_url: URL, _options?: { method?: string }) => ({
    run: <T>(operation: () => T) => operation(),
    snapshot: () => ({ transport_observation: "no_request_event" }),
    finish: () => {},
    ...observation,
  }));
  serviceTransportRuntime[serviceTransportObserverKey] = observer as never;
  return observer;
};

afterEach(() => {
  jest.restoreAllMocks();
  delete serviceTransportRuntime[serviceTransportObserverKey];
  if (originalApiURL === undefined) delete process.env.TRIGGER_API_URL;
  else process.env.TRIGGER_API_URL = originalApiURL;
});

it("ignores callback arguments and keeps the first bounded timing", () => {
  const clock = jest.spyOn(Date, "now").mockReturnValue(1000);
  const diagnostic = createTriggerRunReadDiagnostics({ runId: "run_1" });
  expect(diagnostic.snapshot()).toMatchObject({
    trigger_run_read_api_body: "not_observed",
    trigger_run_read_api_body_elapsed_ms: null,
  });
  const privateBody = new Proxy(
    {},
    {
      get: () => {
        throw new Error("private body read");
      },
    },
  );
  clock.mockReturnValue(3000);
  Reflect.apply(diagnostic.requestOptions.onResponseBody, undefined, [
    privateBody,
    privateBody,
  ]);
  clock.mockReturnValue(100_000);
  diagnostic.requestOptions.onResponseBody();
  expect(diagnostic.snapshot()).toEqual({
    trigger_run_read_diagnostic_version: 1,
    trigger_run_read_api_body: "validated_body_observed",
    trigger_run_read_api_body_elapsed_ms: 2000,
    trigger_run_read_api_body_elapsed_capped: false,
    // No Node observer is registered in this runtime.
    trigger_run_read_transport_diagnostic_version: 1,
    trigger_run_read_transport_state: "unavailable",
    trigger_run_read_transport_request_count: 0,
    trigger_run_read_transport_request_count_capped: false,
  });
  expect(Object.keys(diagnostic.requestOptions)).toEqual(["onResponseBody"]);
});

it.each(["throw", "invalid", "backward", "cap"])(
  "isolates the %s clock case",
  (mode) => {
    const clock = jest.spyOn(Date, "now").mockReturnValue(1000);
    const diagnostic = createTriggerRunReadDiagnostics({ runId: "run_1" });
    if (mode === "throw")
      clock.mockImplementation(() => {
        throw new Error("clock unavailable");
      });
    else
      clock.mockReturnValue(
        mode === "invalid" ? NaN : mode === "backward" ? 500 : 100_000,
      );
    expect(() => diagnostic.requestOptions.onResponseBody()).not.toThrow();
    expect(diagnostic.snapshot()).toMatchObject({
      trigger_run_read_api_body: "validated_body_observed",
      trigger_run_read_api_body_elapsed_ms:
        mode === "throw" || mode === "invalid"
          ? null
          : mode === "backward"
            ? 0
            : 60_000,
      trigger_run_read_api_body_elapsed_capped: mode === "cap",
    });
  },
);

it("keeps concurrent read observations independent", () => {
  const first = createTriggerRunReadDiagnostics({ runId: "run_1" });
  const second = createTriggerRunReadDiagnostics({ runId: "run_2" });
  first.requestOptions.onResponseBody();
  expect(first.snapshot().trigger_run_read_api_body).toBe(
    "validated_body_observed",
  );
  expect(second.snapshot().trigger_run_read_api_body).toBe("not_observed");
});

it.each([
  [undefined, undefined, "https://api.trigger.dev/api/v3/runs/run_1"],
  [
    "https://trigger.internal.test/",
    undefined,
    "https://trigger.internal.test/api/v3/runs/run_1",
  ],
  [
    "https://trigger.internal.test",
    "http://127.0.0.1:8030/prefix/",
    "http://127.0.0.1:8030/prefix/api/v3/runs/run_1",
  ],
])(
  "observes the SDK's exact GET run target (env %s, explicit %s)",
  (env, baseURL, expected) => {
    if (env === undefined) delete process.env.TRIGGER_API_URL;
    else process.env.TRIGGER_API_URL = env;
    const observer = installObserver();
    createTriggerRunReadDiagnostics({ runId: "run_1", baseURL });
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer.mock.calls[0][0].href).toBe(expected);
    expect(observer.mock.calls[0][1]).toEqual({ method: "GET" });
  },
);

it.each([
  "https://user:PRIVATE@trigger.test",
  "https://trigger.test/?token=PRIVATE",
  "https://trigger.test/#PRIVATE",
  "ftp://trigger.test",
  "not a url",
  "",
])(
  "disables only diagnostics for an unsafe or malformed target %p",
  (baseURL) => {
    const observer = installObserver();
    const diagnostic = createTriggerRunReadDiagnostics({
      runId: "run_1",
      baseURL,
    });
    const result = { run: "original" };
    const operation = jest.fn(() => result);
    expect(diagnostic.run(operation)).toBe(result);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(observer).not.toHaveBeenCalled();
    expect(diagnostic.snapshot()).toMatchObject({
      trigger_run_read_transport_state: "unavailable",
      trigger_run_read_transport_request_count: 0,
    });
    expect(JSON.stringify(diagnostic.snapshot())).not.toContain("PRIVATE");
  },
);

it.each([
  [
    {
      transport_observation: "response_headers_received",
      transport_request_count: 40,
      socket_connection_age_ms: 12,
      socket_prior_service_use_observed: true,
      node_version: "22.0.0",
    },
    ["response_headers_received", 16, true],
  ],
  [
    { transport_observation: "request_body_sent", transport_request_count: 16 },
    ["request_body_sent", 16, false],
  ],
  [
    { transport_observation: "no_request_event" },
    ["no_request_event", 0, false],
  ],
  [
    { transport_observation: "socket_assigned", transport_request_count: 1.5 },
    ["socket_assigned", 0, false],
  ],
  [
    { transport_observation: "PRIVATE_FUTURE", transport_request_count: 2 },
    ["unavailable", 0, false],
  ],
  [{ transport_observation: "unavailable" }, ["unavailable", 0, false]],
])(
  "projects only finite transport fields from %j",
  (fields, [state, count, capped]) => {
    installObserver({ snapshot: () => fields });
    const snapshot = createTriggerRunReadDiagnostics({
      runId: "run_1",
    }).snapshot();
    expect(snapshot).toMatchObject({
      trigger_run_read_transport_diagnostic_version: 1,
      trigger_run_read_transport_state: state,
      trigger_run_read_transport_request_count: count,
      trigger_run_read_transport_request_count_capped: capped,
    });
    expect(Object.keys(snapshot)).toHaveLength(8);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /PRIVATE|socket_(connection|prior)|22\.0\.0/,
    );
  },
);

describe("observer failures", () => {
  const result = { run: "original" };
  const fail = () => {
    throw new Error("PRIVATE_OBSERVER");
  };

  it.each<[string, Partial<ServiceTransportObservation>]>([
    ["run throws before the read", { run: fail }],
    [
      "run throws after the read",
      {
        run: (operation) => {
          operation();
          return fail();
        },
      },
    ],
    [
      "run calls the read twice",
      {
        run: (operation) => {
          operation();
          return operation();
        },
      },
    ],
    ["run never calls the read", { run: () => undefined as never }],
    ["snapshot and finish throw", { snapshot: fail, finish: fail }],
  ])("%s: calls the read once and returns its result", (_case, observation) => {
    installObserver(observation);
    const diagnostic = createTriggerRunReadDiagnostics({ runId: "run_1" });
    const operation = jest.fn(() => result);
    expect(diagnostic.run(operation)).toBe(result);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(() => diagnostic.finish()).not.toThrow();
    expect(diagnostic.snapshot()).toMatchObject({
      trigger_run_read_api_body: "not_observed",
    });
  });

  it("rethrows the read's own error once, even when the observer factory fails", () => {
    const error = new Error("original read error");
    for (const install of [
      () => installObserver({ run: (operation) => operation() }),
      () => {
        serviceTransportRuntime[serviceTransportObserverKey] = fail as never;
      },
    ]) {
      install();
      const diagnostic = createTriggerRunReadDiagnostics({ runId: "run_1" });
      const operation = jest.fn(() => {
        throw error;
      });
      let thrown: unknown;
      try {
        diagnostic.run(operation);
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown).toBe(error);
      expect(operation).toHaveBeenCalledTimes(1);
    }
  });
});

it("passes the installed SDK contract over real local HTTP and Node fetch", () => {
  // The standalone fixture also runs directly under Linux; keep it isolated
  // from Jest globals and from any host Trigger configuration or credential.
  const child = spawnSync(
    process.execPath,
    ["lib/api/__tests__/fixtures/trigger-run-read-transport.cjs"],
    {
      cwd: process.cwd(),
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
      encoding: "utf8",
    },
  );
  const lines = (child.stdout ?? "").trim().split("\n");
  const report = JSON.parse(lines[lines.length - 1] || "{}");
  expect({ status: child.status, report }).toEqual({
    status: 0,
    report: expect.objectContaining({
      fixture: "trigger-run-read-transport",
      result: "pass",
      stages: [
        "request_before_headers",
        "headers_held_body",
        "validated_body_before_packet",
        "payload_result",
        "retry_503_then_valid",
        "malformed_json",
        "schema_rejection",
        "http_403",
        "non_undici_fetch_not_inferred",
      ],
      node_version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      trigger_sdk_version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    }),
  });
  expect(`${child.stdout}${child.stderr}`).not.toMatch(
    /127\.0\.0\.1|PRIVATE|tr_dev_|api\/v3/,
  );
}, 40_000);
