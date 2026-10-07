---
name: hackerai-retention-analysis
description: Analyze HackerAI subscriber churn, renewal, and payment recovery, or design a comparison of how a product or model change affects paid retention. Distinguish early experience warnings from mature billing outcomes using aggregate evidence. Not for changing billing or routing, or reading customer conversations.
---

# HackerAI Retention Analysis

Determine whether comparable subscribers leave more often after a change, what
the data can establish now, and what evidence or follow-up is still missing.

## Workflow

1. Establish the question, intended environment, population, comparison, and
   time window. Verify the analytics project's timezone and instrumentation
   coverage. Inspect repository instrumentation first; use the connected
   analytics and billing tools for current evidence within the authorized scope.
2. For cohort design, outcome definitions, billing reconciliation, and readout
   wording, consult the relevant sections of the
   [measurement guide](references/measurement-guide.md). Prefer valid historical
   randomized assignment. Otherwise use pre-exposure comparability and label
   the result observational. Preserve original assignment and report actual
   exposure, crossover, and missing outcomes separately.
3. Produce an immediate experience readout where available, then distinguish
   mature cancellation decisions, renewal retention, and invoice-linked payment
   recovery. Use equal follow-up, appropriate user/subscription/invoice units,
   and uncertainty that accounts for repeated runs per user. Keep subscribers
   who cancel before their baseline renewal date in the renewal comparison.
4. Lead with early warning, mature increase/decrease, inconclusive, or not
   measurable. Include both groups' numerators and denominators, absolute
   differences, uncertainty, limitations, next valid readout, and a concrete
   recommendation. Payment-failed endings do not rule out dissatisfaction.
5. Save reproducible bounded queries and aggregate results in a dated task
   artifact. Keep volatile results out of this skill. Update external tracking
   or schedule follow-ups only when authorized by the user's task.

## Boundaries

This is an analysis workflow, not authorization to change routing, prices,
allowances, feature flags, customer billing, or source configuration. Missing
tables or credentials are evidence gaps, not permission to repair a deployment.
Follow the repository's environment and credential boundaries.

Keep customer content out of analytics queries and reports. If the user requests
content-based qualitative research, use the separate
[HackerAI user research workflow](../hackerai-user-research/SKILL.md) and its
authorized gateway. Do not silently expand aggregate retention analysis into
conversation inspection.
