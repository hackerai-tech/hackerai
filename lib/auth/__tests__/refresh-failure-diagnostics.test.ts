import { getRefreshFailureDiagnostics } from "../refresh-failure-diagnostics";

it("identifies a stable JOSE code even when the error class name is bundled", () => {
  expect(
    getRefreshFailureDiagnostics({
      name: "a",
      code: "ERR_JWE_INVALID",
      message: "private-session-material",
    }),
  ).toMatchObject({
    auth_refresh_diagnostic_version: 2,
    auth_refresh_error_kind: "other_error",
    auth_refresh_error_code: "ERR_JWE_INVALID",
    auth_refresh_error_status: null,
  });
});

it("distinguishes the AuthKit wrapper from its public JOSE cause without contents", () => {
  const fields = getRefreshFailureDiagnostics({
    name: "AuthKitError",
    message: "private-session-material",
    data: { token: "private-token" },
    cause: {
      name: "JWKSTimeout",
      code: "ERR_JWKS_TIMEOUT",
      message: "private-provider-material",
    },
  });
  expect(fields).toMatchObject({
    auth_refresh_error_kind: "AuthKitError",
    auth_refresh_error_code: "none",
    auth_refresh_cause_kind: "JWKSTimeout",
    auth_refresh_cause_code: "ERR_JWKS_TIMEOUT",
  });
  expect(JSON.stringify(fields)).not.toContain("private-");
});

it("does not treat a private suffix or a public-looking prefix as an allowed code", () => {
  const fields = getRefreshFailureDiagnostics({
    name: "JWEInvalid-private-name",
    code: "ERR_JWE_INVALID-private-token",
    cause: {
      name: "AuthKitError-private-name",
      code: "ERR_JOSE_private-token",
    },
  });
  expect(fields).toMatchObject({
    auth_refresh_error_kind: "other_error",
    auth_refresh_error_code: "other",
    auth_refresh_cause_kind: "other_error",
    auth_refresh_cause_code: "other",
  });
  expect(JSON.stringify(fields)).not.toContain("private-");
});

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
    auth_refresh_diagnostic_version: 2,
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
