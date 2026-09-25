# Retired free monthly budget pilot

[HAC-115](https://linear.app/hackerai/issue/HAC-115) records the original
$0.25 versus $0.50 proposal. The Gmail quota migration it depended on was
canceled, and no monthly budget experiment enrolled in application code.
The proposal remains in Backlog for an independent redesign.

The `free_monthly_budget_v1` flags in Preview and Production were archived in
September 2026. Ask and Agent now apply the existing $0.25 monthly default,
the permanent regional cap, and any stricter operational override directly.
Existing usage and quota identities are unchanged. The historical
[readout query](free-monthly-budget-readout.sql) remains for reference; it is
not evidence that this pilot launched.

A future pilot needs a fresh allocation, enrollment and measurement design in
HAC-115, with separate Preview and Production flags and verified Vercel and
Trigger runtime identities before activation.
