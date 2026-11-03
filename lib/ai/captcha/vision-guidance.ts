// Delivered only by the gated Preview tool on the allowlisted image demos.
// These instructions improve the observation loop; they do not establish that
// a provider will accept an answer or that the browser is trusted.
export const CAPTCHA_VISION_GUIDANCE = `Vision-only demo workflow (only when the user authorized solving):
- Use the current owned browser and normal mouse/keyboard input. Do not call solve for a vision-only task. Do not use external solvers/OCR, sample answers, hidden DOM answers/tokens, callbacks, token injection, or browser/network fingerprint changes.
- Take a viewport screenshot, then file view it BEFORE choosing an answer. Read the exact instruction and determine whether this is a tile grid, dynamic replacement grid, or object/shape canvas. Re-read after every round; never carry an old target category into a new one.
- If details are small, crop the challenge INCLUDING its instruction and action button, enlarge 2x, and file view that crop. Keep the original viewport image. Convert crop pixels back to viewport pixels: viewportX = cropLeft + cropX / scale; viewportY = cropTop + cropY / scale. Recalculate after scrolling, resizing, or a new layout. Screenshot coordinates are not browser page coordinates on a full-page image.
- For a static grid, label rows/columns and choose all cells matching the exact instruction. Use fresh control refs or viewport mouse coordinates. Inspect the selection markers before advancing; an issued click is not evidence of a selection.

reCAPTCHA:
- In a replacement grid, click ONE matching tile, then capture and file view the updated grid before choosing another. If that tile is fading/loading, wait for its visible replacement to settle and inspect again. Track selected checks versus new replacement images; do not click the old tile again to toggle it off or batch clicks from a stale screenshot.
- For instructions asking for all squares containing an object, include cells containing visible parts of that object. Inspect uncertain cells at higher resolution rather than guessing from a tiny overview.
- Click Verify only after the current settled grid has no remaining matching replacement tiles, or the intended static cells are visibly selected. NEXT means another round, not success. After Verify, inspect the widget and any visible error before continuing.

hCaptcha:
- Follow the actual prompt, including non-grid shape, object, click-order, or drag tasks. For object/shape clicks, target a visible solid part or stroke belonging to the chosen object; do not assume a hollow center is clickable. Confirm visible selection feedback before Next/Verify. If no feedback appears, inspect the current image before any correction; do not blindly toggle the same coordinate.
- For closed-loop tasks, inspect the complete boundary for a gap or opening. Do not infer closure from the object's label or silhouette alone. If visual evidence remains ambiguous, report that limit instead of inventing certainty.

Completion and limits:
- Keep a short round record: exact instruction, observed selections, action, and visible result. Maximum two Verify submissions, six round advances, and four minutes of solving per demo; obey any stricter user limit. Stop on an explicit block or expiry. If blocked or the budget is exhausted, use browser_handoff when continued human help is requested; for a bounded evaluation, record incomplete and finish cleanup.
- A closed challenge dialog is not proof of success. Confirm the original checkbox/widget is checked, then submit only the authorized demo form normally and inspect its actual acceptance or rejection. Preserve original before/after screenshots and report widget completion separately from website acceptance. Never treat a test-key control as a real solve.`;
