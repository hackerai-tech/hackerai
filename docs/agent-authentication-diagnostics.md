# Cookie authentication diagnostics

Use `verify_authentication` before attributing an HTTP failure to an expired
session. It executes in the selected sandbox through the existing foreground
terminal approval and cancellation path. Parent and subagents have the same
tool, with their existing ownership and authorization boundaries.

The caller supplies a known, permitted JSON identity endpoint and two existing,
authorized sandbox-local files. Both files must be regular files owned by the
runtime user, with no group/other access (normally mode `0600`), at most 256 KiB.
The tool never reads credential values back to the model. Do not populate a real
credential file by pasting secrets into command arguments or chat tool inputs.

The expectation file binds the check to an exact origin and account:

```json
{
  "origin": "https://app.example",
  "identity_pointer": "/user/id",
  "identity": "expected-account-id"
}
```

Use an application identity endpoint whose response establishes the current
account. An arbitrary echo endpoint or public profile cannot establish login.
HTTP 200 alone is insufficient. The response must be successful JSON with the
expected identity at that JSON Pointer, without a recognized challenge or error.
Challenge detection is bounded and heuristic; unknown responses remain a reason
to inspect the actual browser state, not to infer cookie expiry.

Choose the credential format explicitly:

- `cookie_header`: one `Cookie:` header, semicolon-separated `name=value` pairs,
  or one pair per line. These bytes carry no domain, path or expiry metadata;
  their use is restricted to the supplied endpoint and expected origin. Do not
  convert a scoped jar into this format to bypass its restrictions.
- `netscape`: a Netscape jar with its format header and tab-separated fields.
  Domain/tail matching, path, Secure and expiry determine which cookies attach.
  Expiry `0` retains curl's session-cookie meaning. A raw `name=value` file is
  rejected, rather than silently treated as an empty jar by curl.
- `browser_state`: a plaintext object containing `cookies` and `origins` arrays.
  Only matching cookies participate in this HTTP check. Local/session storage
  is never turned into headers. This does not reproduce browser SameSite context
  or authenticate a storage-token application. Partitioned cookies are rejected.
  Encrypted managed browser checkpoints are not accepted or decrypted; use the
  existing managed browser recovery flow and inspect the actual account UI.

The helper uses Python Requests already installed in the Cloud sandbox. Local
and Desktop connections need existing `python3` and Requests; the tool does not
install dependencies. It performs one GET with verified TLS. It does not follow
redirects, use ambient `.netrc` credentials or environment proxies, retry
automatically, or persist session state. It caps response reads and imposes a
20-second total deadline.
No response body, cookie name/value, or observed identity is returned or saved.

`client_request_verified` means the client request object that received the
response contained the intended Cookie header. It is not a packet capture or a
server-side trace. Controlled fixture tests additionally check the server's
received header. `authenticated` establishes only the expected account on this
cookie-authenticated endpoint; it does not establish authorization elsewhere.

`invalid_cookie_format`, `credentials_not_sent`, `challenge_required`,
`identity_mismatch`, `authentication_failed`, and `authentication_unverified`
require different next steps. A 401/403 yields rejection with an unknown cause,
never proof of expiry. Redirects are reported without contacting their targets,
including same-origin login redirects. Use the separately authorized browser
flow for challenges and storage-dependent authentication.

For local fixture tests, point `HACKERAI_AUTH_TEST_PYTHON` at an isolated Python
environment containing Requests, then run `pnpm test:changed`. CI supplies this
dependency separately from the application dependency tree. The fixture suite
uses synthetic credentials and owned loopback servers, including a reproduction
of raw cookie text incorrectly passed to `curl -b`.
