import { getUploadFailureDiagnostics } from "../sandbox-upload-diagnostics";

const signedUrl =
  "https://upload.example/private-file?X-Amz-Date=20261025T175700Z&X-Amz-Expires=60&X-Amz-Credential=fixture-credential&X-Amz-Signature=fixture-signature";
const now = Date.parse("2026-10-25T17:57:09.000Z");

test("reports a curl HTTP failure and signing timing without signing material", () => {
  const result = getUploadFailureDiagnostics(
    signedUrl,
    new Error(
      "Failed to upload file: curl: (22) The requested URL returned error: 403",
    ),
    now,
  );
  expect(result).toEqual({
    upload_reported_http_status: 403,
    upload_signature_age_ms: 9_000,
    upload_signature_ttl_ms: 60_000,
    upload_signature_remaining_ms: 51_000,
  });
  expect(JSON.stringify(result)).not.toMatch(
    /upload\.example|private-file|fixture-|X-Amz/,
  );
});

test.each([
  ["2026-10-25T17:59:00Z", 120_000, -60_000],
  ["2026-10-25T17:56:59Z", -1_000, 61_000],
])(
  "retains signed timing for expiry or clock-skew investigation (%s)",
  (time, age, remaining) => {
    expect(
      getUploadFailureDiagnostics(signedUrl, "", Date.parse(time)),
    ).toMatchObject({
      upload_signature_age_ms: age,
      upload_signature_remaining_ms: remaining,
    });
  },
);

test.each([
  "not-a-url",
  "https://upload.example/no-signature",
  signedUrl.replace("20261025", "20260230"),
  signedUrl.replace("Expires=60", "Expires=0"),
  signedUrl.replace("Expires=60", "Expires=Infinity"),
  `${signedUrl}&X-Amz-Date=20261025T175700Z`,
  `${signedUrl}&X-Amz-Expires=90`,
])("keeps unavailable signing timing unknown (%s)", (url) => {
  expect(
    getUploadFailureDiagnostics(
      url,
      "curl: (22) The requested URL returned error: 500",
      now,
    ),
  ).toEqual({
    upload_reported_http_status: 500,
    upload_signature_age_ms: null,
    upload_signature_ttl_ms: null,
    upload_signature_remaining_ms: null,
  });
});

test.each([
  "File not found: /private/403",
  "server returned 403",
  "File not found: /private/Failed to upload file: curl: (22) The requested URL returned error: 403",
  "curl: (22) The requested URL returned error: 403-private-data",
  "curl: (22) The requested URL returned error: 403 https://private.example",
  "curl: (35) SSL connection failed",
])("does not guess an HTTP status from arbitrary error text (%s)", (error) => {
  expect(
    getUploadFailureDiagnostics(signedUrl, error, now)
      .upload_reported_http_status,
  ).toBeNull();
});

test("unusual errors and invalid clocks cannot break failure logging", () => {
  const error = new Error();
  Object.defineProperty(error, "message", {
    get: () => {
      throw new Error("unreadable");
    },
  });
  expect(() =>
    getUploadFailureDiagnostics(signedUrl, error, now),
  ).not.toThrow();
  expect(
    getUploadFailureDiagnostics(signedUrl, error, NaN).upload_signature_age_ms,
  ).toBeNull();
});
