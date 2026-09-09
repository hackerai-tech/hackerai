# Europe-first OpenRouter routing

For European users, Ask and Agent can prefer EU inference endpoints while
retaining global availability. This is a regional preference, not an EU-only
data-residency guarantee.

The trusted Vercel `x-vercel-ip-continent: EU` header determines eligibility.
Agent jobs carry that decision in `isEuropeanUser`; the worker's region does
not determine the user's location. Missing geography and older queued jobs use
global routing.

The server-side PostHog flag `openrouter_eu_routing_v1` must also evaluate to
`true`. Missing, disabled, failed, or slow flag evaluation uses global routing.
Evaluation is bounded to one second. The production flag starts disabled at 0%;
configure an explicit internal allowlist before activation.

## Request behavior

- Cache the public EU model catalog for five minutes, with a two-second lookup
  timeout and a thirty-second backoff after lookup failure.
- If the primary model is absent from the catalog, send the original request
  directly to global, even if one of its fallback models is EU-eligible.
- Otherwise send it to `https://eu.openrouter.ai/api/v1/chat/completions`.
- On a pre-stream no-endpoint/no-allowed-provider 404 or provider-unavailable
  503, retry the original request once through the global endpoint.
- Keep model order, provider restrictions, headers, request repairs, and abort
  signals. Never replay an accepted stream, a network failure with unknown
  inference status, or auth, billing, and guardrail failures.

The request-scoped provider is used by the main Ask/Agent inference loops.
Standalone helpers using `myProvider` directly, including titles and automatic
approval review, continue to use global routing.

## Measurement and rollback

`openrouter_eu_routing_exposed` fires once per chat request when an EU inference
request is actually attempted. Assignment and catalog lookup are not exposure.
`openrouter_eu_routing_global_fallback` records endpoint-unavailable fallback.
These events carry only the user identifier, flag value, and fixed route outcome.
Use completion/error events and existing model attribution to assess reliability,
latency, and cost. OpenRouter's reported region is diagnostic metadata, not proof
that a global request was constrained to EU providers.

Disable the flag to roll back subsequent requests. Review the internal canary
before expanding the rollout. Owner, review date, guardrails, and flag cleanup
are tracked in [HAC-105](https://linear.app/hackerai/issue/HAC-105).

## Manual verification

1. On a preview deployment, allowlist an internal user and make an Ask request
   from Europe. For an EU-eligible model, verify an EU attempt and a normal
   response. Repeat with Agent, checking the job's `isEuropeanUser` value.
2. Select a model absent from the current EU catalog. Verify a normal global
   response with the same selected model and no EU exposure event.
3. For an EU model without an allowed regional provider, verify EU then global
   and a normal response. Preserve the account's provider restrictions.
4. Repeat from outside Europe and with the flag disabled. Both should use global
   without an EU catalog lookup or exposure event.
5. Cancel a request and verify that no global replay follows cancellation. A
   started stream must never be replayed after an error.

OpenRouter Business or Enterprise access is required for in-region routing.
See [OpenRouter's documentation](https://openrouter.ai/docs/guides/features/in-region-routing).
