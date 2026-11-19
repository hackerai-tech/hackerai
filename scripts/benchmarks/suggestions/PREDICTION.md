# Evaluating next-input predictions

The product objective is predicting what this user is likely to type next, in
their voice and context. Usefulness is a guardrail, not permission to substitute
an assistant's recommended next task. Direct answers, choices and short editable
confirmations can be complete predictions.

Synthetic reviewers can judge prediction plausibility; they cannot establish
actual next-message accuracy. That requires observed subsequent inputs under an
appropriate privacy-safe evaluation design. Do not label an LLM rating as user
accuracy, task success or causal retention benefit.

Use `prediction` fixtures with the existing paired generation/review export.
Freeze the candidate, inputs and review rubric before provider calls. Reviewers
see shuffled outputs and conversation context, without arm, timing or cost.
Keep repeated runs in the same scenario cluster. Score prediction fit and
usefulness separately; flag invented observations, false tool-state claims,
unrequested agenda and ignored stops. Retain failed/absent outputs in denominators
and distinguish explicit stop prechecks from model-selected silence.

Prediction fit, 0–3: 0 contradicts the user's intent, reverses roles or provides
no plausible reply; 1 merely related, generic, repetitive or prescriptive; 2 a
plausible next input from this user; 3 a natural, specific likely reply matching
the immediate conversational cue and the user's style. A justified abstention
on a completed/stopped conversation is reported separately from continuation
fit. Do not penalize a short direct answer for failing to add another task.

Keep run-specific hypotheses, budgets, acceptance criteria, registrations,
results and decisions private under the owning issue. Preserve earlier results
under their original scoring protocol; new objectives do not retroactively
change those scores or turn previously used fixtures into fresh holdouts.
