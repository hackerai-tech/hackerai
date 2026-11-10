# CAPTCHA fallback

CAPTCHA handling runs inside `run_terminal_cmd`; it does not add a model-facing
tool. After opening a browser page, the Agent takes a standalone foreground
`agent-browser snapshot -i` (optionally with `--session NAME` before `snapshot`).
A successful snapshot checks the browser already owned by that run without
starting a paid task. A supported pending challenge returns `solve_available`
and instructions in `result.browserChallenge`. The Agent decides whether solving
is necessary and authorized, then calls `run_terminal_cmd` with the exact
`hackerai-captcha solve --session NAME` command supplied by that result. This is
a runtime operation, not an installed shell program. It revalidates the owned
session and document before admitting one 2Captcha attempt. The Agent must then
verify the website's response, submitting a form only when authorized. Token
delivery alone is not acceptance.

Eligible terminal tools include only a short CAPTCHA hint. Detailed workflow
guidance is returned once per handler/run after the owned page reports a pending
challenge, including unsupported challenges. Ordinary pages and inspection
failures before detection receive no detailed guide. The provider module is
initialized only after an explicit solve request, challenge validation and durable admission; cancellation
is rechecked after initialization before any paid task is created. No CAPTCHA
MCP schemas or extra model-facing tools are loaded.

If a snapshot includes output formatting such as `| tail`, the terminal result
asks the Agent to repeat the snapshot alone. That formatting command never
starts a paid solve. Solve requests must also be standalone, foreground and
non-interactive. To decline solving and restore a captured managed widget, use
the supplied `hackerai-captcha release --session NAME` command.

`result.browserChallenge` is runtime metadata attached to the terminal tool
result, not shell output. Searching terminal logs cannot recover this status.
Keep named sessions short (at most 24 characters) to fit managed Unix socket
paths. An initializing widget may need an observed-readiness wait followed by
another standalone snapshot; repeated snapshot polling does not improve solving.

This path requires a full-access parent Agent run. It supports visible
reCAPTCHA v2, hCaptcha and standalone Turnstile widgets that expose their public
site key and response field. Managed Cloudflare challenges have a separate
Preview-only capture path described below. Invisible/enterprise challenges, multiple
pending widgets, DataDome and GeeTest are not implemented. Unsupported or
failed challenges require human verification. `browser_handoff` can hand over
only the current Cloud browser; for connected Local, Desktop and remote browsers,
the Agent stops and explains that in-app takeover is unavailable. Older clients without
protected stdin support remain ineligible. Normal browser commands still work.

## Managed Cloudflare in Preview

Managed support is restricted to trusted Trigger Preview workers. The same
PostHog flag controls capture and paid solving; no separate URL opt-in is needed.
Only public HTTPS pages without credentials, unrelated query parameters or
fragments qualify. Transient Cloudflare challenge query parameters are stripped.
An eligible run installs a capture hook before navigation on Cloud, Local,
Desktop and remote browsers running agent-browser 0.39.3 or newer. The hook
holds the managed widget until the Agent requests solving or releases it.

Managed tasks share the public URL, captured challenge parameters and browser
user agent with 2Captcha. Returned responses and user agents travel through
protected stdin, with session/document checks before delivery. A bounded
post-delivery check distinguishes a cleared gate from a pending or replacement
challenge; it does not prove form acceptance. Failed delivery restores the
widget when possible. A solved CAPTCHA cannot guarantee access past a site's
other anti-bot or access restrictions.

Release records a page-specific manual-verification preference in the owned
tab's session storage, including when a detached container prevents replay.
Reloading that page then uses the original widget instead of capturing it again.
The preference expires with the tab; it does not change other pages or solver
eligibility. If the page cannot execute release or session storage is unavailable,
this recovery is best-effort and must not be reported as successful verification.

## Server configuration

Configure each environment independently. Preview uses its designated
Development Convex deployment and Trigger Preview branch; Production uses its
designated Production Convex deployment and Trigger Production environment.
Never reuse configuration from the other environment as a shortcut.

The only CAPTCHA-specific environment variable is `TWOCAPTCHA_API_KEY`, set in
both Trigger and its matching Convex deployment. Trigger creates and polls tasks;
Convex independently reconciles late costs. The boolean PostHog flag
`browser_captcha_solver_v1` controls rollout and user targeting in the matching
PostHog project. A disabled, missing or unavailable flag prevents paid solving.
No enablement, user-list, target-list or journal-switch environment variables
are required or read.

The API key comes from the **2Captcha customer dashboard**, not a CAPTCHA
website's public site key. Store it only in server-side secrets. Do not add it to
`NEXT_PUBLIC_*`, Vercel's browser bundle, local/remote sandbox environments,
terminal commands, prompts or Desktop configuration. Cloud, remote and Desktop
all use the same server-side adapter.

Changing worker code requires a Trigger deployment. Configuration/flag changes
apply to new Agent runs. Deploy the Convex functions and configure their matching
secrets before enabling the worker; failed durable admission prevents solving.
Use the same flag key independently in Preview and Production. Legacy pilot
flags and environment switches are no longer read. PostHog controls eligibility,
not payment initiation: the Agent still explicitly requests each solve after
observing a supported challenge in its owned browser.

Supported widgets on public HTTPS pages qualify without a site list. The URL
must not include credentials, query parameters or fragments (except the stripped
Cloudflare parameters above). Only the public URL and required widget/challenge
parameters are shared with 2Captcha, never cookies or page content. Session,
document and widget identity are revalidated before delivery.

## Costs and failure handling

Before creating a task, a Convex transaction reserves one attempt for the run and
consumes fixed daily admission limits: 100 globally and 10 per user per UTC day. This survives model fallback and process
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
