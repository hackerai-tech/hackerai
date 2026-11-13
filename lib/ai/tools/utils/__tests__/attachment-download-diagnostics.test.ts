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
