import {
  copyAttachmentDownloadFailureContext,
  recordAttachmentDownloadBoundary,
  getAttachmentDownloadFailureContext,
  recordAttachmentDownloadFailure,
  recordAttachmentCommandReceiver,
  recordAttachmentDownloadRoute,
  recordAttachmentCommandSetupAttempt,
  type AttachmentCommandReceiver,
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
    /customer|private|failure|schannel|certificate/,
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

it("classifies the public PowerShell secure-channel failure without exporting private suffixes", () => {
  const error = Object.freeze(new Error("private original"));
  expect(
    recordAttachmentDownloadFailure(error, {
      ...input,
      shell: "cmd",
      httpClient: "powershell",
      stderr:
        "Invoke-WebRequest : The request was aborted: Could not create SSL/TLS secure channel. https://private.example/object?signature=secret",
    }),
  ).toBe(error);
  expect(getAttachmentDownloadFailureContext(error)).toMatchObject({
    attachment_download_stderr_signal: "tls",
    attachment_download_reported_http_status: null,
    attachment_download_stderr_truncated: false,
  });
  expect(
    JSON.stringify(getAttachmentDownloadFailureContext(error)),
  ).not.toMatch(/private|signature|secret|Invoke-WebRequest|secure channel/);
});

it("does not treat a generic PowerShell abort as TLS or scan past the existing budget", () => {
  const classify = (stderr: string) =>
    getAttachmentDownloadFailureContext(
      recordAttachmentDownloadFailure(new Error(), {
        ...input,
        shell: "cmd",
        httpClient: "powershell",
        stderr,
      }),
    );
  expect(classify("The request was aborted")).toMatchObject({
    attachment_download_stderr_signal: "other",
  });
  expect(
    classify("x".repeat(8192) + "Could not create SSL/TLS secure channel"),
  ).toMatchObject({
    attachment_download_stderr_signal: "other",
    attachment_download_stderr_truncated: true,
  });
  expect(
    classify(
      "The remote server returned an error: (403) Forbidden. Could not create SSL/TLS secure channel",
    ),
  ).toMatchObject({
    attachment_download_stderr_signal: "http_status",
    attachment_download_reported_http_status: 403,
  });
});

it.each([
  ["curl: (28) Resolving timed out after 10000 milliseconds", "resolving"],
  ["curl: (28) Connection timed out after 30000 milliseconds", "connect"],
  [
    "curl: (28) Failed to connect to private.example port 443 after 10000 ms: Timeout was reached",
    "connect",
  ],
  ["curl: (28) SSL connection timeout", "tls_handshake"],
  ["curl: (28) SSL/TLS connection timeout", "tls_handshake"],
  [
    "curl: (28) Operation timed out after 30000 milliseconds with 0 bytes received",
    "operation",
  ],
  [
    "curl: (28) Resolving timed out after 10000 milliseconds\ncurl: (28) SSL connection timeout",
    "multiple",
  ],
  ["curl: (28) private unrecognized detail", "unclassified"],
  ["private error mentions Resolving timed out", "unclassified"],
  ["", "unclassified"],
])(
  "keeps only the reported curl28 timeout wording family: %s",
  (stderr, hint) => {
    const original = Object.freeze(new Error("private original"));
    expect(
      recordAttachmentDownloadFailure(original, {
        ...input,
        exitCode: 28,
        stderr: `${stderr}\nhttps://private.example/secret?token=private`,
      }),
    ).toBe(original);
    const fields = getAttachmentDownloadFailureContext(original);
    expect(fields).toMatchObject({
      attachment_download_timeout_version: 1,
      attachment_download_timeout_hint: hint,
      attachment_download_exit_code: 28,
    });
    expect(JSON.stringify(fields)).not.toMatch(
      /private|secret|token|milliseconds|Resolving|Connection|SSL/,
    );
  },
);

it.each([
  ["curl", 7],
  ["curl", 35],
  ["curl", 23],
  ["wget", 28],
  ["powershell", 28],
] as const)(
  "does not assign curl28 wording to selected %s exit%s",
  (httpClient, exitCode) => {
    const original = recordAttachmentDownloadFailure(new Error(), {
      ...input,
      httpClient,
      exitCode,
      stderr: "curl: (28) SSL connection timeout",
    });
    const fields = getAttachmentDownloadFailureContext(original);
    expect(fields).not.toHaveProperty("attachment_download_timeout_version");
    expect(fields).not.toHaveProperty("attachment_download_timeout_hint");
  },
);

it("bounds timeout wording scans and retains it through existing boundary and copy propagation", () => {
  const original = recordAttachmentDownloadFailure(
    new Error("private original"),
    {
      ...input,
      exitCode: 28,
      stderr: "x".repeat(8192) + "\ncurl: (28) Resolving timed out",
    },
  );
  recordAttachmentDownloadBoundary(original, {
    phase: "failure_diagnostics",
    attempt: 3,
    resultState: "nonzero",
  });
  const copy = copyAttachmentDownloadFailureContext(
    original,
    new Error("private wrapper"),
  );
  expect(getAttachmentDownloadFailureContext(copy)).toMatchObject({
    attachment_download_timeout_version: 1,
    attachment_download_timeout_hint: "unclassified",
    attachment_download_stderr_truncated: true,
    attachment_download_attempt: 3,
  });
  const fields = getAttachmentDownloadFailureContext(copy)!;
  fields.attachment_download_exit_code = 0;
  expect(
    getAttachmentDownloadFailureContext(copy)?.attachment_download_exit_code,
  ).toBe(28);
});

const curl1Protocol =
  'curl: (1) Protocol "privateproto" not supported or disabled in libcurl';

it.each([
  [curl1Protocol, true, "protocol_unsupported_or_disabled"],
  [
    `progress\r\n${curl1Protocol}\r\n`,
    true,
    "protocol_unsupported_or_disabled",
  ],
  [
    'curl: (1) Protocol "h t/tp:" not supported or disabled in libcurl',
    true,
    "protocol_unsupported_or_disabled",
  ],
  // Other curl versions' or incomplete wording stays unclassified.
  ['curl: (1) Protocol "privateproto" not supported', true, "unclassified"],
  [`${curl1Protocol} private suffix`, true, "unclassified"],
  [
    'curl: (1) Protocol "private"proto" not supported or disabled in libcurl',
    true,
    "unclassified",
  ],
  [
    `curl: (1) Protocol "${"p".repeat(65)}" not supported or disabled in libcurl`,
    true,
    "unclassified",
  ],
  [
    'curl: (1) Protocol "" not supported or disabled in libcurl',
    true,
    "unclassified",
  ],
  ["curl: (1) private unrecognized detail", true, "unclassified"],
  [curl1Protocol.toUpperCase(), false, "unclassified"],
  [curl1Protocol.replace("Protocol", "protocol"), true, "unclassified"],
  [curl1Protocol.slice("curl: (1) ".length), false, "unclassified"],
  [`private prefix ${curl1Protocol}`, false, "unclassified"],
  [` ${curl1Protocol}`, false, "unclassified"],
  [curl1Protocol.replace("(1)", "(10)"), false, "unclassified"],
  ["curl: option --private: is unknown", false, "unclassified"],
  [
    "curl: (26) Failed to open/read local data from private",
    false,
    "unclassified",
  ],
  ["", false, "unclassified"],
])(
  "keeps only the closed public curl1 wording family: %j",
  (stderr, linePresent, hint) => {
    const original = Object.freeze(new Error("private original"));
    expect(
      recordAttachmentDownloadFailure(original, {
        ...input,
        stderr: `${stderr}\nhttps://private.example/secret?token=private`,
      }),
    ).toBe(original);
    const fields = getAttachmentDownloadFailureContext(original);
    expect(fields).toMatchObject({
      attachment_download_curl1_version: 1,
      attachment_download_curl1_line_present: linePresent,
      attachment_download_curl1_hint: hint,
      attachment_download_exit_code: 1,
      attachment_download_stderr_signal: "other",
    });
    expect(fields).not.toHaveProperty("attachment_download_timeout_hint");
    expect(JSON.stringify(fields)).not.toMatch(
      /private|secret|token|libcurl|Protocol|h t\/tp|ppp/,
    );
    expect(Object.keys(original)).toEqual([]);
  },
);

it.each([
  ["curl", 2],
  ["curl", 26],
  ["curl", 28],
  ["curl", 0],
  ["wget", 1],
  ["powershell", 1],
] as const)(
  "does not assign curl1 wording to selected %s exit%s",
  (httpClient, exitCode) => {
    const fields = getAttachmentDownloadFailureContext(
      recordAttachmentDownloadFailure(new Error(), {
        ...input,
        httpClient,
        exitCode,
        stderr: curl1Protocol,
      }),
    );
    expect(fields).toHaveProperty("attachment_download_exit_code", exitCode);
    for (const key of [
      "attachment_download_curl1_version",
      "attachment_download_curl1_line_present",
      "attachment_download_curl1_hint",
    ])
      expect(fields).not.toHaveProperty(key);
  },
);

it("bounds curl1 wording scans and retains it through existing boundary and copy propagation", () => {
  const classify = (stderr: string) => {
    const original = recordAttachmentDownloadFailure(
      Object.freeze(new Error("private original")),
      { ...input, stderr },
    );
    recordAttachmentDownloadBoundary(original, {
      phase: "failure_diagnostics",
      attempt: 3,
      resultState: "nonzero",
    });
    return getAttachmentDownloadFailureContext(
      copyAttachmentDownloadFailureContext(
        original,
        new Error("private wrapper"),
      ),
    );
  };
  expect(classify(`${"x".repeat(8191)}\n${curl1Protocol}`)).toMatchObject({
    attachment_download_curl1_line_present: false,
    attachment_download_curl1_hint: "unclassified",
    attachment_download_stderr_truncated: true,
  });
  // A public line cut by the existing budget is present but unclassified.
  expect(classify(`${"x".repeat(8150)}\n${curl1Protocol}`)).toMatchObject({
    attachment_download_curl1_line_present: true,
    attachment_download_curl1_hint: "unclassified",
    attachment_download_stderr_truncated: true,
  });
  expect(classify(`${"x".repeat(8100)}\n${curl1Protocol}`)).toMatchObject({
    attachment_download_curl1_version: 1,
    attachment_download_curl1_line_present: true,
    attachment_download_curl1_hint: "protocol_unsupported_or_disabled",
    attachment_download_stderr_truncated: false,
    attachment_download_attempt: 3,
    attachment_download_result_context_present: true,
  });
});

it.each([
  // The budget can end exactly after the wording while the line continues.
  [
    `${"x".repeat(8192 - curl1Protocol.length - 1)}\n${curl1Protocol} private suffix`,
    "unclassified",
  ],
  // A newline-terminated line before the cut remains complete.
  [
    `${"x".repeat(8000)}\n${curl1Protocol}\n${"y".repeat(500)}`,
    "protocol_unsupported_or_disabled",
  ],
])(
  "classifies curl1 wording only from lines completed before truncation (%#)",
  (stderr, hint) => {
    expect(
      getAttachmentDownloadFailureContext(
        recordAttachmentDownloadFailure(new Error(), { ...input, stderr }),
      ),
    ).toMatchObject({
      attachment_download_curl1_line_present: true,
      attachment_download_curl1_hint: hint,
      attachment_download_stderr_truncated: true,
    });
  },
);

const illegalMessage =
  "curl: (35) schannel: next InitializeSecurityContext failed: SEC_E_ILLEGAL_MESSAGE (0x80090326) - This error usually occurs when a fatal SSL/TLS alert is received (e.g. handshake failed). More detail may be available in the Windows System event log.";
const noRevocationCheck =
  "curl: (35) schannel: next InitializeSecurityContext failed: CRYPT_E_NO_REVOCATION_CHECK (0x80092012) - The revocation function was unable to check revocation for the certificate.";
const receiveFailed =
  "curl: (35) schannel: failed to receive handshake, SSL/TLS connection failed";
const opensslSyscall =
  "curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to private.example:443 ";
const opensslEof =
  "curl: (35) TLS connect error: OpenSSL/3.0.13: error:0A000126:SSL routines::unexpected eof while reading";
const curl35PrivacyCanary =
  /private|secret|token=|SEC_E|CRYPT_E|0x|Initialize|revocation function|SSL routines|error:0A|OpenSSL\/|connection to|443|event log/;

it.each([
  [illegalMessage, "schannel_illegal_message"],
  [noRevocationCheck, "schannel_revocation_unavailable"],
  [
    "curl: (35) schannel: next InitializeSecurityContext failed: CRYPT_E_REVOCATION_OFFLINE (0x80092013)",
    "schannel_revocation_unavailable",
  ],
  // Localized system text after the symbol and code is accepted, never kept.
  [
    "curl: (35) schannel: initial InitializeSecurityContext failed: SEC_E_INVALID_TOKEN (0x80090308) - Le jeton fourni à la fonction n’est pas valide",
    "schannel_invalid_token",
  ],
  [
    "curl: (35) schannel: next InitializeSecurityContext failed: SEC_E_INTERNAL_ERROR (0x80090304) - The Local Security Authority cannot be contacted",
    "schannel_internal_error",
  ],
  [
    "curl: (35) schannel: initial InitializeSecurityContext failed: SEC_E_ALGORITHM_MISMATCH (0x80090331) - The client and server cannot communicate, because they do not possess a common algorithm.",
    "schannel_algorithm_mismatch",
  ],
  [receiveFailed, "schannel_handshake_receive_failed"],
  [opensslSyscall, "openssl_syscall"],
  [opensslSyscall.trimEnd(), "openssl_syscall"],
  [
    "curl: (35) BoringSSL SSL_connect: SSL_ERROR_SYSCALL in connection to 10.0.0.1:8443 ",
    "openssl_syscall",
  ],
  [opensslEof, "openssl_unexpected_eof"],
  [
    "curl: (35) TLS connect error: OpenSSL/3.5.1: error:0A00010B:SSL routines::wrong version number",
    "openssl_wrong_version",
  ],
  [`progress\r\n${illegalMessage}\r\n`, "schannel_illegal_message"],
  // One repeated family, including both revocation statuses, is not conflicting.
  [
    `${noRevocationCheck}\n${noRevocationCheck}`,
    "schannel_revocation_unavailable",
  ],
  [
    `${noRevocationCheck}\ncurl: (35) schannel: initial InitializeSecurityContext failed: CRYPT_E_REVOCATION_OFFLINE (0x80092013)`,
    "schannel_revocation_unavailable",
  ],
  [`${illegalMessage}\ncurl: (35) private detail`, "schannel_illegal_message"],
  [`${illegalMessage}\n${receiveFailed}`, "multiple"],
  [`${opensslEof}\r\n${opensslSyscall}\r\n`, "multiple"],
])("keeps only a closed public curl35 reason family: %j", (stderr, hint) => {
  const original = Object.freeze(new Error("private original"));
  expect(
    recordAttachmentDownloadFailure(original, {
      ...input,
      shell: "cmd",
      exitCode: 35,
      stderr: `${stderr}\nhttps://private.example/secret?token=private`,
    }),
  ).toBe(original);
  const fields = getAttachmentDownloadFailureContext(original);
  expect(fields).toMatchObject({
    attachment_download_curl35_version: 1,
    attachment_download_curl35_line_present: true,
    attachment_download_curl35_hint: hint,
    attachment_download_exit_code: 35,
  });
  expect(JSON.stringify(fields)).not.toMatch(curl35PrivacyCanary);
  expect(Object.keys(original)).toEqual([]);
});

it.each([
  // Other SSPI statuses, unnamed codes and mismatched pairs stay unclassified.
  [
    "curl: (35) schannel: next InitializeSecurityContext failed: SEC_E_CERT_EXPIRED (0x80090328)",
    true,
  ],
  [
    "curl: (35) schannel: next InitializeSecurityContext failed: Unknown error (0x80092012) - The revocation function was unable to check revocation for the certificate.",
    true,
  ],
  [
    "curl: (35) schannel: next InitializeSecurityContext failed: SEC_E_ILLEGAL_MESSAGE (0x80090308)",
    true,
  ],
  [illegalMessage.replace("(0x80090326)", "(0X80090326)"), true],
  [
    "curl: (35) schannel: next InitializeSecurityContext failed: SEC_E_ILLEGAL_MESSAGE (0x80090326) -",
    true,
  ],
  [illegalMessage.replace("next", "final"), true],
  [`${receiveFailed} private suffix`, true],
  // A socket error replaces the public SSL_ERROR_SYSCALL name.
  [
    "curl: (35) OpenSSL SSL_connect: Connection reset by peer in connection to private.example:443 ",
    true,
  ],
  [opensslSyscall.replace("443", "private"), true],
  // Other library formats, reason codes or a private suffix stay unknown.
  [
    "curl: (35) error:1408F10B:SSL routines:ssl3_get_record:wrong version number",
    true,
  ],
  [opensslEof.replace("0A000126", "0A00010B"), true],
  [opensslEof.replace("OpenSSL/3.0.13", "LibreSSL/3.8.2"), true],
  [`${opensslEof} private`, true],
  ["curl: (35) private unrecognized detail", true],
  // Only anchored complete curl35 lines count.
  [` ${illegalMessage}`, false],
  [`private prefix ${receiveFailed}`, false],
  [`'${receiveFailed}'`, false],
  [`progress\r${illegalMessage}`, false],
  [illegalMessage.replace("(35)", "(60)"), false],
  [illegalMessage.slice("curl: (35) ".length), false],
  ["", false],
])(
  "leaves unsupported or malformed curl35 wording unclassified: %j",
  (stderr, linePresent) => {
    const fields = getAttachmentDownloadFailureContext(
      recordAttachmentDownloadFailure(Object.freeze(new Error("private")), {
        ...input,
        shell: "cmd",
        exitCode: 35,
        stderr: `${stderr}\nhttps://private.example/secret?token=private`,
      }),
    );
    expect(fields).toMatchObject({
      attachment_download_curl35_version: 1,
      attachment_download_curl35_line_present: linePresent,
      attachment_download_curl35_hint: "unclassified",
    });
    expect(JSON.stringify(fields)).not.toMatch(curl35PrivacyCanary);
  },
);

it.each([
  ["curl", 60],
  ["curl", 28],
  ["curl", 1],
  ["curl", 0],
  ["wget", 35],
  ["powershell", 35],
] as const)(
  "does not assign curl35 wording to selected %s exit%s",
  (httpClient, exitCode) => {
    const fields = getAttachmentDownloadFailureContext(
      recordAttachmentDownloadFailure(new Error(), {
        ...input,
        httpClient,
        exitCode,
        stderr: illegalMessage,
      }),
    );
    expect(fields).toHaveProperty("attachment_download_exit_code", exitCode);
    for (const key of [
      "attachment_download_curl35_version",
      "attachment_download_curl35_line_present",
      "attachment_download_curl35_hint",
    ])
      expect(fields).not.toHaveProperty(key);
  },
);

it.each([
  // A newline-terminated line before the cut remains complete.
  [
    `${"x".repeat(8000)}\r\n${receiveFailed}\r\n${"y".repeat(500)}`,
    true,
    "schannel_handshake_receive_failed",
  ],
  // The budget can end exactly after the wording while the line continues.
  [
    `${"x".repeat(8192 - receiveFailed.length - 1)}\n${receiveFailed} private suffix`,
    true,
    "unclassified",
  ],
  // A public line cut by the existing budget is present but unclassified.
  [`${"x".repeat(8150)}\n${illegalMessage}`, true, "unclassified"],
  [`${"x".repeat(8192)}\n${illegalMessage}`, false, "unclassified"],
])(
  "classifies curl35 wording only from lines completed before truncation (%#)",
  (stderr, linePresent, hint) => {
    expect(
      getAttachmentDownloadFailureContext(
        recordAttachmentDownloadFailure(new Error(), {
          ...input,
          exitCode: 35,
          stderr,
        }),
      ),
    ).toMatchObject({
      attachment_download_curl35_line_present: linePresent,
      attachment_download_curl35_hint: hint,
      attachment_download_stderr_truncated: true,
    });
  },
);

it("adds curl35 fields without changing other context and retains them through boundary and copy propagation", () => {
  const original = Object.freeze(new Error("private original"));
  recordAttachmentDownloadFailure(original, {
    ...input,
    shell: "cmd",
    exitCode: 35,
    stderr: `${noRevocationCheck}\r\n`,
    directoryProbe: {
      state: "returned",
      output: "target_dir_exists=true\r\n",
      truncated: false,
    },
  });
  recordAttachmentDownloadBoundary(original, {
    phase: "failure_diagnostics",
    attempt: 3,
    resultState: "nonzero",
  });
  const copy = copyAttachmentDownloadFailureContext(
    original,
    new Error("private wrapper"),
  );
  const fields = getAttachmentDownloadFailureContext(copy)!;
  expect(fields).toEqual({
    attachment_download_diagnostic_version: 1,
    attachment_download_platform: "windows",
    attachment_download_shell: "cmd",
    attachment_download_http_client: "curl",
    attachment_download_exit_code: 35,
    attachment_download_stderr_signal: "tls",
    attachment_download_reported_http_status: null,
    attachment_download_stderr_truncated: false,
    attachment_download_curl35_version: 1,
    attachment_download_curl35_line_present: true,
    attachment_download_curl35_hint: "schannel_revocation_unavailable",
    attachment_download_directory_probe_version: 1,
    attachment_download_directory_probe_state: "returned",
    attachment_download_target_dir_exists: true,
    attachment_download_target_dir_writable: null,
    attachment_download_directory_probe_truncated: false,
    attachment_download_boundary_version: 1,
    attachment_download_phase: "failure_diagnostics",
    attachment_download_attempt: 3,
    attachment_download_result_state: "nonzero",
    attachment_download_error_kind: "error",
    attachment_download_result_context_present: true,
  });
  fields.attachment_download_curl35_hint = "multiple";
  expect(
    getAttachmentDownloadFailureContext(copy)?.attachment_download_curl35_hint,
  ).toBe("schannel_revocation_unavailable");
  expect(original.message).toBe("private original");
  expect(Object.keys(original)).toEqual([]);
});

const notRecognized = (program: string) =>
  `'${program}' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n`;
const powerShellParserError = [
  "At C:\\private\\hackerai-transfer.ps1:1 char:20",
  "+ $url='https://private.example' 'x'",
  "+                                ~~~",
  "Unexpected token ''x'' in expression or statement.",
  "    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException",
  "    + FullyQualifiedErrorId : UnexpectedToken",
].join("\r\n");

it.each([
  // Both previously reported only the coarse command_syntax signal.
  [
    "curl",
    "bash",
    127,
    "/bin/bash: line 1: curl: command not found",
    "selected_client_not_found",
  ],
  [
    "curl",
    "bash",
    2,
    "/bin/bash: -c: line 1: syntax error near unexpected token `('\n/bin/bash: -c: line 1: `curl -o '/private/path' 'https://private.example/x'('",
    "posix_syntax",
  ],
  [
    "curl",
    "bash",
    127,
    "bash: curl: command not found\n",
    "selected_client_not_found",
  ],
  [
    "curl",
    "bash",
    127,
    "/usr/bin/bash: line 1: curl.exe: command not found",
    "selected_client_not_found",
  ],
  ["curl", "bash", 127, "sh: 1: curl: not found", "selected_client_not_found"],
  [
    "curl",
    "bash",
    127,
    "/bin/sh: curl: not found",
    "selected_client_not_found",
  ],
  [
    "curl",
    "bash",
    127,
    "zsh:1: command not found: curl",
    "selected_client_not_found",
  ],
  [
    "curl",
    "bash",
    127,
    "Command 'curl' not found, but can be installed with:\n\nsudo apt install curl",
    "selected_client_not_found",
  ],
  ["curl", "cmd", 9009, notRecognized("curl"), "selected_client_not_found"],
  ["curl", "cmd", 9009, notRecognized("curl.exe"), "selected_client_not_found"],
  [
    "wget",
    "bash",
    127,
    "bash: line 1: wget: command not found\r\n",
    "selected_client_not_found",
  ],
  [
    "wget",
    "bash",
    127,
    "/usr/bin/bash: line 1: wget.exe: command not found",
    "selected_client_not_found",
  ],
  [
    "powershell",
    "cmd",
    9009,
    notRecognized("powershell"),
    "selected_client_not_found",
  ],
  [
    "powershell",
    "bash",
    127,
    "/usr/bin/bash: line 1: powershell.exe: command not found",
    "selected_client_not_found",
  ],
  // Another program, a non-alias spelling or a path is not the selected client.
  [
    "wget",
    "bash",
    127,
    "bash: line 1: curl: command not found",
    "other_command_not_found",
  ],
  [
    "curl",
    "bash",
    127,
    "/bin/bash: line 1: privatetool: command not found",
    "other_command_not_found",
  ],
  [
    "curl",
    "bash",
    127,
    "bash: line 1: Curl: command not found",
    "other_command_not_found",
  ],
  [
    "curl",
    "cmd",
    9009,
    notRecognized("C:\\private\\curl.exe"),
    "other_command_not_found",
  ],
  ["powershell", "cmd", 9009, notRecognized("pwsh"), "other_command_not_found"],
  // Missing selected client while the command's mkdir failed is still a 127 result.
  [
    "curl",
    "bash",
    127,
    "mkdir: cannot create directory '/private': Permission denied\nbash: line 1: curl: command not found",
    "selected_client_not_found",
  ],
  [
    "curl",
    "bash",
    2,
    "bash: -c: line 2: syntax error: unexpected end of file",
    "posix_syntax",
  ],
  [
    "curl",
    "bash",
    2,
    "bash: -c: line 1: syntax error: unexpected end of file from `{' command on line 1",
    "posix_syntax",
  ],
  [
    "curl",
    "bash",
    2,
    "/bin/bash: -c: line 1: unexpected EOF while looking for matching `''\n/bin/bash: -c: line 2: syntax error: unexpected end of file",
    "posix_syntax",
  ],
  ["curl", "bash", 2, 'sh: 1: Syntax error: "(" unexpected', "posix_syntax"],
  [
    "curl",
    "bash",
    2,
    "/bin/sh: 1: Syntax error: Unterminated quoted string",
    "posix_syntax",
  ],
  [
    "curl",
    "bash",
    2,
    "sh: syntax error: unterminated quoted string",
    "posix_syntax",
  ],
  ["powershell", "cmd", 1, powerShellParserError, "windows_syntax"],
  // Conflicting observed families stay explicit; one repeated family does not.
  [
    "curl",
    "bash",
    127,
    "bash: line 1: curl: command not found\nbash: line 1: privatetool: command not found",
    "multiple",
  ],
  [
    "curl",
    "bash",
    127,
    "bash: line 1: curl: command not found\nbash: line 2: curl: command not found",
    "selected_client_not_found",
  ],
  [
    "curl",
    "bash",
    2,
    "/bin/bash: -c: line 1: syntax error near unexpected token `('\nbash: line 1: curl: command not found",
    "multiple",
  ],
  [
    "curl",
    "bash",
    127,
    "zsh:1: command not found: curl\nzsh:1: parse error near `)'",
    "multiple",
  ],
  [
    "curl",
    "cmd",
    9009,
    `${notRecognized("curl")}& was unexpected at this time.\r\n`,
    "multiple",
  ],
  // Eligible results without a complete public shell line stay unclassified.
  ["curl", "bash", 127, "", "unclassified"],
  [
    "curl",
    "bash",
    127,
    "private note: curl: command not found",
    "unclassified",
  ],
  [
    "curl",
    "bash",
    127,
    " bash: line 1: curl: command not found",
    "unclassified",
  ],
  [
    "curl",
    "bash",
    127,
    "bash: line 1: curl: command not found private suffix",
    "unclassified",
  ],
  [
    "curl",
    "bash",
    127,
    "/home/private/bin/bash: line 1: curl: command not found",
    "unclassified",
  ],
  [
    "curl",
    "bash",
    127,
    "bash: line 1: private tool: command not found",
    "unclassified",
  ],
  [
    "curl",
    "bash",
    127,
    "progress\rbash: line 1: curl: command not found",
    "unclassified",
  ],
  [
    "curl",
    "bash",
    2,
    "private text mentions syntax error near unexpected token `('",
    "unclassified",
  ],
  ["curl", "bash", 1, "unexpected token in private input", "unclassified"],
  [
    "curl",
    "cmd",
    1,
    "'curl' is not recognized as an internal command",
    "unclassified",
  ],
] as const)(
  "keeps only a closed command hint for selected %s via %s exit%s: %j",
  (httpClient, shell, exitCode, stderr, hint) => {
    const original = Object.freeze(new Error("private original"));
    expect(
      recordAttachmentDownloadFailure(original, {
        ...input,
        platform: "unknown",
        httpClient,
        shell,
        exitCode,
        stderr,
      }),
    ).toBe(original);
    const fields = getAttachmentDownloadFailureContext(original);
    expect(fields).toMatchObject({
      attachment_download_command_hint_version: 1,
      attachment_download_command_hint: hint,
      attachment_download_http_client: httpClient,
    });
    expect(JSON.stringify(fields)).not.toMatch(
      /private|pwsh|Curl|\.exe|not found|recognized|syntax error|unexpected|token|Command '|apt/,
    );
    expect(Object.keys(original)).toEqual([]);
  },
);

it.each([
  [22, "curl: (22) The requested URL returned error: 403", "http_status"],
  [6, "curl: (6) Could not resolve host: private.example", "dns"],
  [28, "curl: (28) Resolving timed out after 10000 milliseconds", "other"],
  [1, curl1Protocol, "other"],
  [126, "bash: line 1: /usr/bin/curl: Permission denied", "permission"],
  [1, "The syntax of the command is incorrect.", "other"],
  [1, "zsh:1: parse error near `)'", "other"],
])(
  "does not add a command hint to unrelated exit%s results",
  (exitCode, stderr, signal) => {
    const fields = getAttachmentDownloadFailureContext(
      recordAttachmentDownloadFailure(new Error(), {
        ...input,
        exitCode,
        stderr,
      }),
    );
    expect(fields).toHaveProperty("attachment_download_stderr_signal", signal);
    expect(fields).not.toHaveProperty(
      "attachment_download_command_hint_version",
    );
    expect(fields).not.toHaveProperty("attachment_download_command_hint");
  },
);

const selectedMissing = "bash: line 1: curl: command not found";

it.each([
  // The budget can end exactly after the wording while the line continues.
  [
    `${"x".repeat(8192 - selectedMissing.length - 1)}\n${selectedMissing} private suffix`,
    "unclassified",
  ],
  [`${"x".repeat(8192)}\n${selectedMissing}`, "unclassified"],
  // A newline-terminated line before the cut remains complete.
  [
    `${"x".repeat(8000)}\r\n${selectedMissing}\r\n${"y".repeat(500)}`,
    "selected_client_not_found",
  ],
])(
  "classifies command hints only from lines completed before truncation (%#)",
  (stderr, hint) => {
    expect(
      getAttachmentDownloadFailureContext(
        recordAttachmentDownloadFailure(new Error(), {
          ...input,
          exitCode: 127,
          stderr,
        }),
      ),
    ).toMatchObject({
      attachment_download_command_hint: hint,
      attachment_download_stderr_truncated: true,
    });
  },
);

it("retains the command hint through existing boundary and copy propagation", () => {
  const original = recordAttachmentDownloadFailure(
    Object.freeze(new Error("private original")),
    { ...input, exitCode: 127, stderr: selectedMissing },
  );
  recordAttachmentDownloadBoundary(original, {
    phase: "failure_diagnostics",
    attempt: 3,
    resultState: "nonzero",
  });
  const copy = copyAttachmentDownloadFailureContext(
    original,
    new Error("private wrapper"),
  );
  const fields = getAttachmentDownloadFailureContext(copy)!;
  expect(fields).toMatchObject({
    attachment_download_command_hint_version: 1,
    attachment_download_command_hint: "selected_client_not_found",
    attachment_download_attempt: 3,
    attachment_download_result_context_present: true,
  });
  fields.attachment_download_command_hint = "posix_syntax";
  expect(
    getAttachmentDownloadFailureContext(copy)?.attachment_download_command_hint,
  ).toBe("selected_client_not_found");
  expect(
    getAttachmentDownloadFailureContext(original)
      ?.attachment_download_command_hint,
  ).toBe("selected_client_not_found");
  expect(Object.keys(original)).toEqual([]);
});

const directoryKeys = [
  "attachment_download_directory_probe_version",
  "attachment_download_directory_probe_state",
  "attachment_download_target_dir_exists",
  "attachment_download_target_dir_writable",
  "attachment_download_directory_probe_truncated",
];
const probeFields = (
  directoryProbe: Parameters<
    typeof recordAttachmentDownloadFailure
  >[1]["directoryProbe"],
) =>
  getAttachmentDownloadFailureContext(
    recordAttachmentDownloadFailure(Object.freeze(new Error("private")), {
      ...input,
      exitCode: 23,
      directoryProbe,
    }),
  );
const dfPrivate =
  "Filesystem Size Used Avail Use% Mounted on\n/dev/private-disk 10G 9G 1G 90% /private-mount\n";

it("omits directory probe fields when the caller supplied no observation", () => {
  const fields = probeFields(undefined);
  expect(fields).toHaveProperty("attachment_download_exit_code", 23);
  for (const key of directoryKeys) expect(fields).not.toHaveProperty(key);
});

it("keeps an unavailable directory probe unmeasured rather than false", () => {
  const fields = probeFields({ state: "unavailable" })!;
  expect(fields).toMatchObject({
    attachment_download_directory_probe_version: 1,
    attachment_download_directory_probe_state: "unavailable",
  });
  for (const key of [
    "attachment_download_target_dir_exists",
    "attachment_download_target_dir_writable",
    "attachment_download_directory_probe_truncated",
  ])
    expect(fields[key as keyof typeof fields]).toBeNull();
});

it.each([
  [
    `target_dir_exists=true\ntarget_dir_writable=false\n${dfPrivate}`,
    true,
    false,
  ],
  ["target_dir_exists=false\ntarget_dir_writable=false", false, false],
  // cmd.exe output uses CRLF and keeps the space echoed before `||`.
  ["target_dir_exists=true\r\ntarget_dir_writable=true \r\n", true, true],
  // Each flag is independent; a missing one is never inferred.
  ["target_dir_exists=true\n", true, null],
  [`target_dir_writable=false\n${dfPrivate}`, null, false],
  ["", null, null],
  // Same valid duplicate is kept; a conflicting duplicate is unknown.
  ["target_dir_exists=true\ntarget_dir_exists=true\n", true, null],
  [
    "target_dir_exists=true\ntarget_dir_writable=true\ntarget_dir_exists=false\n",
    null,
    true,
  ],
  // Only complete exact anchored lines count.
  ["target_dir_exists=TRUE\ntarget_dir_writable=yes\n", null, null],
  [" target_dir_exists=true\nprivate target_dir_writable=true\n", null, null],
  ["target_dir_exists=true private\nxtarget_dir_writable=true\n", null, null],
  ["target_dir_exists=true\rtarget_dir_writable=true\n", null, null],
  ["\ttarget_dir_exists=true\ntarget_dir_writable=\ttrue\n", null, null],
])(
  "parses only closed directory probe lines: %j",
  (output, exists, writable) => {
    const fields = probeFields({ state: "returned", output, truncated: false });
    expect(fields).toMatchObject({
      attachment_download_directory_probe_version: 1,
      attachment_download_directory_probe_state: "returned",
      attachment_download_target_dir_exists: exists,
      attachment_download_target_dir_writable: writable,
      attachment_download_directory_probe_truncated: false,
    });
    expect(JSON.stringify(fields)).not.toMatch(
      /private|Filesystem|Mounted|dev\/|90%|=true|=false/,
    );
  },
);

it.each([
  // The scan-cut final line may continue past the existing budget.
  [`target_dir_exists=true\ntarget_dir_writable=true`, true, true, null],
  [`target_dir_exists=false\ntarget_dir_writable=false\n`, true, false, false],
  ["target_dir_exists=true", true, null, null],
  // The helper caps independently even if the caller did not report a cut.
  [
    `target_dir_exists=true\n${"x".repeat(1100)}\ntarget_dir_writable=false\n`,
    false,
    true,
    null,
  ],
  [
    `target_dir_exists=false\n${"x".repeat(1024 - "target_dir_exists=false\n".length - "\ntarget_dir_writable=true".length)}\ntarget_dir_writable=true more`,
    false,
    false,
    null,
  ],
])(
  "drops only the incomplete scan tail of a truncated directory probe (%#)",
  (output, truncated, exists, writable) => {
    expect(probeFields({ state: "returned", output, truncated })).toMatchObject(
      {
        attachment_download_directory_probe_state: "returned",
        attachment_download_target_dir_exists: exists,
        attachment_download_target_dir_writable: writable,
        attachment_download_directory_probe_truncated: true,
      },
    );
  },
);

it("retains directory probe fields through existing boundary and copy propagation", () => {
  const original = recordAttachmentDownloadFailure(
    Object.freeze(new Error("private original")),
    {
      ...input,
      exitCode: 23,
      directoryProbe: {
        state: "returned",
        output: `target_dir_exists=true\r\ntarget_dir_writable=false\r\n${dfPrivate}`,
        truncated: false,
      },
    },
  );
  recordAttachmentDownloadBoundary(original, {
    phase: "failure_diagnostics",
    attempt: 3,
    resultState: "nonzero",
  });
  const fields = getAttachmentDownloadFailureContext(
    copyAttachmentDownloadFailureContext(
      original,
      new Error("private wrapper"),
    ),
  )!;
  expect(fields).toMatchObject({
    attachment_download_directory_probe_state: "returned",
    attachment_download_target_dir_exists: true,
    attachment_download_target_dir_writable: false,
    attachment_download_attempt: 3,
    attachment_download_result_context_present: true,
  });
  expect(JSON.stringify(fields)).not.toMatch(/private|Filesystem|dev\//);
  expect(Object.keys(original)).toEqual([]);
});

const deadlineReceiver: AttachmentCommandReceiver = {
  reason: "deadline",
  connectedObserved: true,
  subscribedObserved: true,
  publicationStarted: true,
  publishCompleted: true,
  firstMessageObserved: false,
};

it("records receiver and setup context on a hostile rejection without touching it", () => {
  const privateRead = jest.fn(() => {
    throw new Error("private trap");
  });
  const hostile = new Proxy(
    {},
    {
      get: privateRead,
      has: privateRead,
      ownKeys: privateRead,
      getOwnPropertyDescriptor: privateRead,
      getPrototypeOf: privateRead,
      set: privateRead,
      defineProperty: privateRead,
    },
  );
  recordAttachmentCommandReceiver(hostile, deadlineReceiver);
  recordAttachmentCommandSetupAttempt(hostile, 2);
  recordAttachmentDownloadRoute(hostile, "native_method");
  const wrapper = copyAttachmentDownloadFailureContext(
    hostile,
    new Error("private wrapper"),
  );
  expect(privateRead).not.toHaveBeenCalled();
  expect(getAttachmentDownloadFailureContext(wrapper)).toEqual({
    attachment_command_receiver_version: 1,
    attachment_command_receiver_reason: "deadline",
    attachment_command_receiver_connected_observed: true,
    attachment_command_receiver_subscribed_observed: true,
    attachment_command_receiver_publication_started: true,
    attachment_command_receiver_publish_completed: true,
    attachment_command_receiver_first_message_observed: false,
    attachment_command_setup_version: 1,
    attachment_command_setup_attempt: 2,
    attachment_download_route_version: 1,
    attachment_download_route: "native_method",
    attachment_download_boundary_present: false,
  });
});

it("retains receiver and setup context through the later existing boundary", () => {
  const error = Object.freeze(new Error("private original"));
  recordAttachmentCommandSetupAttempt(error, 1);
  recordAttachmentCommandReceiver(error, {
    ...deadlineReceiver,
    reason: "presence_missing",
    publicationStarted: false,
    publishCompleted: false,
  });
  recordAttachmentDownloadBoundary(error, {
    phase: "http_client",
    attempt: 0,
    resultState: "not_observed",
  });
  expect(getAttachmentDownloadFailureContext(error)).toMatchObject({
    attachment_command_receiver_reason: "presence_missing",
    attachment_command_receiver_publication_started: false,
    attachment_command_setup_attempt: 1,
    attachment_download_phase: "http_client",
    attachment_download_result_context_present: false,
  });
  expect(Object.keys(error)).toEqual([]);
});

it("keeps setup attempts bounded and primitives unrecorded", () => {
  for (const attempt of [0, 3, 1.5, NaN]) {
    const error = new Error();
    recordAttachmentCommandSetupAttempt(error, attempt);
    expect(getAttachmentDownloadFailureContext(error)).toBeUndefined();
  }
  recordAttachmentCommandReceiver("private", deadlineReceiver);
  recordAttachmentCommandSetupAttempt("private", 1);
  expect(getAttachmentDownloadFailureContext("private")).toBeUndefined();
});

it("reports only the final rejection's receiver context when an earlier failure is wrapped", () => {
  const earlier = new Error("private earlier");
  recordAttachmentCommandReceiver(earlier, deadlineReceiver);
  recordAttachmentCommandSetupAttempt(earlier, 2);
  const final = new Error("private final");
  recordAttachmentCommandReceiver(final, {
    ...deadlineReceiver,
    reason: "client_error",
    subscribedObserved: false,
    publicationStarted: false,
    publishCompleted: false,
  });
  // The existing wrapper copies only the final rejection's evidence.
  const combined = copyAttachmentDownloadFailureContext(
    final,
    new Error("private combined"),
  );
  const fields = getAttachmentDownloadFailureContext(combined)!;
  expect(fields).toMatchObject({
    attachment_command_receiver_reason: "client_error",
    attachment_command_receiver_subscribed_observed: false,
  });
  expect(fields).not.toHaveProperty("attachment_command_setup_attempt");
  // A later attempt record on the final error cannot be replaced by the earlier one.
  recordAttachmentCommandSetupAttempt(final, 1);
  expect(getAttachmentDownloadFailureContext(final)).toMatchObject({
    attachment_command_receiver_reason: "client_error",
    attachment_command_setup_attempt: 1,
  });
  expect(getAttachmentDownloadFailureContext(earlier)).toMatchObject({
    attachment_command_receiver_reason: "deadline",
    attachment_command_setup_attempt: 2,
  });
});
