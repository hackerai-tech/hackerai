# Safe local diagnostics

These developer helpers return fixed fields instead of attempting to redact raw
process listings or authentication pages after capture. They need no new account
or API key. They do not change application state, credentials, or permissions.

## Process health

Use task-owned PIDs recorded at launch:

```sh
pnpm diagnostics:process 12345 12346
```

The command accepts 1–16 positive PIDs on macOS/Linux. It reports PID, parent PID,
normalized state, elapsed seconds, CPU/memory percentages, and an allowlisted
executable name (`other` for unknown names). Missing PIDs are listed separately.
It never requests command arguments or process environments and never returns
arbitrary executable paths. The `ps` child has a five-second deadline and 64 KiB
output limit. Invalid output and execution errors produce a fixed reason without
raw stdout, stderr, or exception details.

This is a point-in-time health observation. Elapsed lifetime is not wasted time,
CPU usage is not proof of a hang, and a PID alone is not authority to kill a
process. The helper does not discover ownership, cancel tasks, restart services,
or enforce host-wide resource limits. Do not fall back to `ps` argument or
environment dumps when a result is unavailable.

## Browser login state

Import `scripts/diagnostics/login-state.mjs` by its absolute checkout path in the
CUA runtime, then pass an existing browser tab binding:

```javascript
var loginDiagnostics =
  await import("/absolute/checkout/scripts/diagnostics/login-state.mjs");
nodeRepl.write(await loginDiagnostics.diagnoseLogin(tab));
```

The default origin allowlist is `https://hackerai.co` and
`https://signin.hackerai.co`. For an authorized Preview or loopback fixture, pass
its independently verified exact origin in `allowedOrigins`; this does not
authorize using Production credentials there. Unsupported origins are rejected
before DOM inspection. URL credentials, paths, query strings, fragment codes,
account identifiers, input values, page text and browser error details are never
returned.

The only output is `{ origin, state }`. States are `email-entry`,
`password-entry`, `verification-required`, `challenge`, `session-ui-present`,
`unknown`, `unsupported-origin`, `page-changed`, or `unavailable`. DOM controls
provide coarse hints, including controls a page may hide. A session UI marker is
not proof of the signed-in account, entitlement, or durable authentication;
verify the account and persistence separately after sign-in.

Read login state before requesting a full accessibility snapshot or screenshot
of an authentication page. If a verification or challenge is present, use only
the minimum controls needed under the current task/tool policy. Do not capture
or echo the challenge code. Errors stay generic even if the browser embeds page
content in an exception. The default three-second deadline bounds the returned
result; it cannot forcibly cancel a browser tool already executing. It never
starts another browser read after returning, retries, or mutates the page.

The machine-local Production QA bridge can re-export `diagnoseLogin` from a
reviewed copy installed beside `credentials.mjs` as `login-diagnostics.mjs`.
Keep that copy independent of disposable worktrees, compare its SHA-256 against
the reviewed source after installing, and retain the existing credential bridge
and signed Keychain helper identity. The local Production login skill owns
sign-in; this module only observes coarse state.

## Verification

`pnpm test:diagnostics` checks real DOM fixtures, adversarial errors, navigation
races, deadlines, malformed process output, and an actual process containing
synthetic argument/environment secrets. It also runs through `test:changed` and
`test:ci`. Browser integration should use disposable loopback fixtures with
synthetic values; it does not require a paid request or a real password.

The helpers constrain their own output. Instructions to use them do not prevent
an operator from bypassing them with a raw diagnostic command.
