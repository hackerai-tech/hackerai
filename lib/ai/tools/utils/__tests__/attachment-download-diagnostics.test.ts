import {
  copyAttachmentDownloadFailureContext,
  recordAttachmentDownloadBoundary,
  getAttachmentDownloadFailureContext,
  recordAttachmentDownloadFailure,
} from "../attachment-download-diagnostics";

const input = {
  platform: "windows" as const,
  shell: "bash" as const,
  httpClient: "curl" as const,
  exitCode: 1,
  stderr: "",
};

it.each([
  ["", "empty"],
  ["permission denied: /private/customer", "permission"],
  ["No space left on device", "disk_full"],
  ["curl: (6) Could not resolve host: private.example", "dns"],
  ["schannel: certificate private details", "tls"],
  ["bash: syntax error near unexpected token", "command_syntax"],
  ["unclassified private failure", "other"],
])("retains only a finite stderr hint for %s", (stderr, hint) => {
  const error = Object.freeze(new Error("private original"));
  expect(recordAttachmentDownloadFailure(error, { ...input, stderr })).toBe(
    error,
  );
  const fields = getAttachmentDownloadFailureContext(error);
  expect(fields?.attachment_download_stderr_signal).toBe(hint);
  expect(JSON.stringify(fields)).not.toMatch(
    /customer|private|unclassified|schannel|certificate/,
  );
  expect(Object.keys(error)).toEqual([]);
});

it.each([
  ["curl", "curl: (22) The requested URL returned error: 403"],
  ["wget", "2026-01-01 ERROR 403: Forbidden."],
  ["powershell", "The remote server returned an error: (403) Forbidden."],
] as const)(
  "binds the reported HTTP status to the selected %s stderr format",
  (httpClient, stderr) => {
    const error = recordAttachmentDownloadFailure(new Error(), {
      ...input,
      httpClient,
      stderr: `${stderr} https://private.example/object?signature=secret`,
    });
    expect(getAttachmentDownloadFailureContext(error)).toMatchObject({
      attachment_download_reported_http_status: 403,
      attachment_download_stderr_signal: "http_status",
    });
    expect(
      JSON.stringify(getAttachmentDownloadFailureContext(error)),
    ).not.toMatch(/private|object|signature|secret/);
  },
);

it("bounds stderr scanning, rejects invalid exits and does not treat arbitrary numbers as HTTP status", () => {
  const error = recordAttachmentDownloadFailure(new Error(), {
    ...input,
    exitCode: Infinity,
    stderr:
      "private403 ".repeat(1000) +
      "curl: (22) The requested URL returned error: 403",
  });
  expect(getAttachmentDownloadFailureContext(error)).toMatchObject({
    attachment_download_exit_code: null,
    attachment_download_reported_http_status: null,
    attachment_download_stderr_signal: "other",
    attachment_download_stderr_truncated: true,
  });
});

it("copies final-attempt evidence without serializing the error or sharing mutable returned fields", () => {
  const final = recordAttachmentDownloadFailure(
    Object.freeze(new Error("secret")),
    {
      ...input,
      exitCode: 22,
      stderr: "curl: (22) The requested URL returned error: 404",
    },
  );
  const combined = copyAttachmentDownloadFailureContext(
    final,
    new Error("combined secret"),
  );
  const read = getAttachmentDownloadFailureContext(combined)!;
  read.attachment_download_exit_code = 0;
  expect(
    getAttachmentDownloadFailureContext(combined)
      ?.attachment_download_exit_code,
  ).toBe(22);
  expect(
    getAttachmentDownloadFailureContext(new Error("unrecorded")),
  ).toBeUndefined();
  expect(getAttachmentDownloadFailureContext(null)).toBeUndefined();
});

it("records unreadable rejection identity without reading private properties and copies the finite boundary", () => {
  const privateRead = jest.fn(() => {
    throw new Error("private getter");
  });
  const unreadable = new Proxy({}, { getPrototypeOf: privateRead });
  Object.defineProperty(unreadable, "message", { get: privateRead });
  recordAttachmentDownloadBoundary(unreadable, {
    phase: "download_command",
    attempt: 1,
    resultState: "not_observed",
  });
  const wrapped = copyAttachmentDownloadFailureContext(
    unreadable,
    new Error("existing wrapper"),
  );
  expect(getAttachmentDownloadFailureContext(wrapped)).toMatchObject({
    attachment_download_error_kind: "unreadable",
    attachment_download_result_context_present: false,
    attachment_download_phase: "download_command",
  });
  // instanceof may inspect the prototype, but private name/message getters are never read.
  expect(privateRead).toHaveBeenCalledTimes(1);
  expect(
    JSON.stringify(getAttachmentDownloadFailureContext(wrapped)),
  ).not.toContain("private");
});
