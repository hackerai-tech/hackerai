# CAPTCHA fallback

CAPTCHA handling runs inside `run_terminal_cmd`; it does not add a model-facing
tool. After opening a browser page, the Agent takes a standalone foreground
`agent-browser snapshot -i` (optionally with `--session NAME` before `snapshot`).
A successful snapshot checks the browser already owned by that run. A supported
pending challenge can receive one 2Captcha attempt. The result appears in
`result.browserChallenge`; the Agent must submit the normal form and verify the
website's response. Token delivery alone is not acceptance.

If a snapshot includes output formatting such as `| tail`, the terminal result
asks the Agent to repeat the snapshot alone. That formatting command never
starts a paid solve.

`result.browserChallenge` is runtime metadata attached to the terminal tool
result, not shell output. Searching terminal logs cannot recover this status.
Keep named sessions short (at most 24 characters) to fit managed Unix socket
paths. An initializing widget may need an observed-readiness wait followed by
another standalone snapshot; repeated snapshot polling does not improve solving.

This path requires a full-access parent Agent run. It supports visible
reCAPTCHA v2, hCaptcha and standalone Turnstile widgets that expose their public
site key and response field. Invisible/enterprise challenges, managed challenge
pages, multiple pending widgets and GeeTest are not implemented. Unsupported or
failed challenges require human verification. `browser_handoff` can hand over
only the current Cloud browser; for connected Local, Desktop and remote browsers,
the Agent stops and explains that in-app takeover is unavailable. Older clients without
protected stdin support remain ineligible. Normal browser commands still work.

## Server configuration

Configure each environment independently. Preview uses its designated
Development Convex deployment and Trigger Preview branch; Production uses its
designated Production Convex deployment and Trigger Production environment.
Never reuse configuration from the other environment as a shortcut.

| Setting                              | Location                                                   | Purpose                                                                                            |
| ------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `TWOCAPTCHA_API_KEY`                 | Trigger environment **and** its matching Convex deployment | 2Captcha account API key. Trigger creates/polls tasks; Convex independently reconciles late costs. |
| `HACKERAI_CAPTCHA_SOLVER_ENABLED=1`  | Trigger environment                                        | Enables automatic fallback, subject to the remaining gates. Explicit `0` disables it.              |
| `CAPTCHA_SOLVER_USER_IDS`            | Trigger environment                                        | Comma-separated internal user IDs eligible for the staged rollout. Empty/unset enables nobody.     |
| `browser_captcha_solver_v1`          | Matching PostHog project                                   | Boolean rollout flag; unavailable/disabled fails closed.                                           |
| `CAPTCHA_SOLVER_TARGETS`             | Trigger environment                                        | Optional exact approved targets, shown below. Without it, only the built-in public demos qualify.  |
| `HACKERAI_CAPTCHA_JOURNAL_ENABLED=1` | Matching Convex deployment                                 | Enables durable admission; missing key or disabled journal prevents paid creation.                 |
| `CAPTCHA_SOLVER_DAILY_ATTEMPTS`      | Matching Convex deployment                                 | Global UTC-day task admission limit; default 100. Set `0` to stop new paid tasks.                  |
| `CAPTCHA_SOLVER_USER_DAILY_ATTEMPTS` | Matching Convex deployment                                 | Per-user UTC-day admission limit; default 10.                                                      |

The API key comes from the **2Captcha customer dashboard**, not a CAPTCHA
website's public site key. Store it only in server-side secrets. Do not add it to
`NEXT_PUBLIC_*`, Vercel's browser bundle, local/remote sandbox environments,
terminal commands, prompts or Desktop configuration. Cloud, remote and Desktop
all use the same server-side adapter.

Changing worker code requires a Trigger deployment. Configuration/flag changes
apply to new Agent runs. Deploy the Convex functions and configure their matching
secrets before enabling the worker; failed durable admission prevents solving.
Legacy Preview-only pilot settings remain recognized when the generic enablement
variable is absent; they never enable Production.

Additional targets require exact HTTPS URLs (no credentials, query or fragment),
kind and public widget key. This explicitly approves sharing that URL and widget
key with 2Captcha; cookies and page content are not shared. Maximum 20 targets:

```json
[
  {
    "url": "https://example.com/test-form",
    "kind": "recaptcha_v2",
    "siteKey": "PUBLIC_WIDGET_KEY"
  }
]
```

## Costs and failure handling

Before creating a task, a Convex transaction reserves one attempt for the run and
consumes its daily admission limits. This survives model fallback and process
loss. Failed or uncertain requests consume the attempt; creation is never
automatically retried. Daily limits count admitted attempts, not dollars, and
provider pricing may change. The prepaid 2Captcha balance remains the provider's
spending limit; do not enable automatic top-ups without an explicit budget.

Known task IDs and validated fees are recorded in `captcha_attempts`. It contains
no URLs, widget keys, API keys or response tokens. A watchdog scheduled before
creation polls known tasks at 30-second intervals, for at most 20 checks. Unknown
creation outcomes or tasks still unresolved at that bound stay `unknown`; they
are not retried or represented as zero-cost successes.

Successful in-run solver fees enter the existing Agent usage calculation. Late
or unconfirmed fees are retained as provider expenses and absorbed by the
platform; reconciliation never replays customer wallet deductions. Do not add
all provider expenses to application usage totals: successful fees are already
included there. User deletion anonymizes these expense records while preserving
pending provider reconciliation, and removes the user's daily-limit records.

Stop cancels delivery and browser work; it cannot cancel a task already accepted
by 2Captcha. A late provider result never resumes the Agent or delivers into a
different page. Browser, document and widget identity are checked again before
delivery. On failure, use human takeover instead of another paid attempt.
