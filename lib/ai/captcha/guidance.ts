// The tool keeps a stable, small hint. Detailed instructions enter model context
// through a result only after the owned browser reports a pending challenge.
export const CAPTCHA_TOOL_HINT =
  "Use agent-browser directly with standalone foreground snapshots. Automatic CAPTCHA handling reports result.browserChallenge; follow its message and guidance.";

export const CAPTCHA_RUNTIME_GUIDANCE = `CAPTCHA workflow for the detected challenge:
- Keep this same owned browser and session. Pass a named session on EVERY browser command; use short names (at most 24 characters). Do not reopen the page, switch browsers, change the runtime-managed environment, or run version/help/skills probes unless an actual command fails with a syntax or availability error.
- result.browserChallenge is runtime metadata in the tool result, not shell stdout. Do not search terminal logs for it. Follow the current status and message without repeating completed steps. Never call external CAPTCHA APIs, obtain solver credentials, read/inject response tokens yourself, or repeat a paid attempt.
- Any snapshot used for automatic handling must be standalone and foreground: no pipes, redirection, waits or appended commands. If a widget is visibly initializing, wait once for an observed readiness condition before another standalone snapshot; do not poll snapshots.
- After token_delivered, take one fresh standalone snapshot and check whether a callback already submitted the form. Submit only if it has not been submitted, then verify actual website acceptance. Delivery alone is not success. For rejection or an uncertain submission outcome, stop for human verification instead of resubmitting.
- Use targeted reads instead of full DOM inventories. Batch known dependent follow-up steps in one foreground call, stopping on errors; keep trigger snapshots separate.
- Capture requested pre-submission or diagnostic screenshots at the requested stage. For final acceptance evidence, verify first. Batch visual-only token redaction and capture, then view the returned image once. Never clear or overwrite response fields to redact them. Do not add file/ls checks after a successful screenshot or create screenshots unless needed.
- browser_handoff can hand over only the current Cloud browser. For Local, Desktop or remote connections, stop and explain that manual verification is required and in-app takeover is unavailable; do not switch to Cloud for handoff. Close only your session when finished, and keep it open while human takeover is needed or pending.`;
