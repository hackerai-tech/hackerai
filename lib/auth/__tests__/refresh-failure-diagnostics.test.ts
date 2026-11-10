import { getRefreshFailureDiagnostics } from "../refresh-failure-diagnostics";

it("keeps root and cause status distinct and excludes private error material", () => {
  const fields = getRefreshFailureDiagnostics({
    name: "OauthException",
    status: 400,
    error: "invalid_client",
    message: "private-token",
    requestID: "private-request",
    rawData: { token: "private-token" },
    cause: {
      name: "private-error-name",
      status: 503,
      code: "private-error-code",
      message: "private-token",
    },
  });
  expect(fields).toMatchObject({
    auth_refresh_diagnostic_version: 1,
    auth_refresh_error_kind: "OauthException",
    auth_refresh_error_status: 400,
    auth_refresh_error_code: "invalid_client",
    auth_refresh_cause_kind: "other_error",
    auth_refresh_cause_status: 503,
    auth_refresh_cause_code: "other",
  });
  expect(JSON.stringify(fields)).not.toContain("private-");
});

it.each([
  [undefined, "absent"],
  ["400", "non_numeric"],
  [600, "out_of_range"],
  [NaN, "non_integer"],
])("does not coerce or emit an invalid HTTP status %s", (status, shape) => {
  expect(getRefreshFailureDiagnostics({ status })).toMatchObject({
    auth_refresh_error_status: null,
    auth_refresh_error_status_shape: shape,
    auth_refresh_cause_kind: "none",
  });
});

it("contains throwing property access without reading deeper causes", () => {
  const unreadable = new Proxy(
    {},
    {
      get() {
        throw new Error("private-getter");
      },
      getPrototypeOf() {
        throw new Error("private-prototype");
      },
      has() {
        throw new Error("private-has");
      },
    },
  );
  expect(getRefreshFailureDiagnostics(unreadable)).toMatchObject({
    auth_refresh_error_kind: "unreadable_error",
    auth_refresh_error_status: null,
    auth_refresh_cause_kind: "unreadable_error",
  });
  const deepCause = jest.fn(() => {
    throw new Error("private-deep-cause");
  });
  const fields = getRefreshFailureDiagnostics({
    name: "Error",
    cause: {
      name: "AbortError",
      get cause() {
        return deepCause();
      },
    },
  });
  expect(fields.auth_refresh_cause_kind).toBe("AbortError");
  expect(deepCause).not.toHaveBeenCalled();
  expect(JSON.stringify(fields)).not.toContain("private-");
});
