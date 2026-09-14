<p align="center">
  <a href="https://hackerai.co/">
    <img src="public/icon-512x512.png" width="150" alt="HackerAI Logo">
  </a>
</p>

<h1 align="center">HackerAI</h1>

<h2 align="center">Your AI-Powered Penetration Testing Assistant</h2>

<div align="center">

[![License](https://img.shields.io/badge/License-Apache%202.0%20with%20Commercial%20Restrictions-red.svg)](LICENSE)
[![Website](https://img.shields.io/badge/Website-hackerai.co-2d3748.svg)](https://hackerai.co)

</div>

## Getting started

Coding agents should start with [AGENTS.md](AGENTS.md).

### Prerequisites

You'll need the following accounts:

**Required:**

- [OpenRouter](https://openrouter.ai/) - AI model provider
- [OpenAI](https://platform.openai.com/) - Identifies security requests that should use [abliteration.ai](https://abliteration.ai/) models
- [E2B](https://e2b.dev/) - Isolated cloud execution in Agent mode
- [Convex](https://www.convex.dev/) - Database and backend
- [Amazon S3](https://aws.amazon.com/s3/) - File storage
- [WorkOS](https://workos.com/) - Authentication and user management
- [Trigger.dev](https://trigger.dev/) - Required durable runtime for agent tasks

**Optional:**

- [abliteration.ai](https://abliteration.ai/) - AI models for security requests that standard models may refuse
- [Perplexity](https://perplexity.ai/) - Web search functionality
- [Jina AI](https://jina.ai/reader) - Web URL content retrieval
- [Redis](https://redis.io/) - Stream resumption
- [Upstash Redis](https://upstash.com/) - Rate limiting
- [PostHog](https://posthog.com/) - Analytics
- [Stripe](https://stripe.com/) - Payment processing

### Clone the repo

```bash
git clone https://github.com/hackerai-tech/hackerai.git
```

### Navigate to the project directory

```bash
cd hackerai
```

### Install dependencies

```bash
pnpm install
```

### Run the setup script

```bash
pnpm run setup
```

To use abliteration.ai for eligible security requests, create an API key in the
[abliteration.ai console](https://abliteration.ai/console) and set
`ABLITERATION_API_KEY` in `.env.local`, Vercel, and Trigger.dev. Without this
optional key, HackerAI continues using its standard models.

### Start the development server

This runs both Next.js and Convex dev servers:

```bash
pnpm run dev
```

Or run them separately in two terminals:

```bash
pnpm run dev:next
pnpm run dev:convex
```

### Run the Trigger.dev worker

Agent mode runs the agent loop on a [Trigger.dev](https://trigger.dev/) task.
To use the agent locally:

1. Create a project at https://cloud.trigger.dev and copy your **dev** secret
   key (`tr_dev_…`) into `.env.local` as `TRIGGER_SECRET_KEY`.
2. In the Trigger.dev dashboard → your project → **Environment Variables**,
   add the env vars the task needs to run (these live on the worker, not on
   Vercel): `NEXT_PUBLIC_CONVEX_URL`, `CONVEX_SERVICE_ROLE_KEY`,
   `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `AWS_S3_ACCESS_KEY_ID`,
   `AWS_S3_SECRET_ACCESS_KEY`, `AWS_S3_REGION`, `AWS_S3_BUCKET_NAME`, and
   `E2B_API_KEY`. Add
   `MIOSA_API_KEY` for the MIOSA rollout or explicit MIOSA testing. New Miosa
   workspaces default to the native `hackerai-tools` template; optionally set
   `MIOSA_TEMPLATE_ID` to override it. An existing `miosa-sandbox-docker`
   override still selects the Docker template, so remove or update that value
   in each intended runtime to use the native default. Existing workspaces
   retain their original runtime and files; E2B remains the cloud fallback.
   Add any optional keys you use
   (`ABLITERATION_API_KEY`, `PERPLEXITY_API_KEY`, `JINA_API_KEY`, etc.).
3. Start the worker in a third terminal:

   ```bash
   pnpm dev:trigger
   ```

   This starts the default Trigger.dev worker used by local Agent requests.
   To start an explicitly routed Trigger.dev branch instead, set a stable
   branch name with
   `TRIGGER_DEV_BRANCH=my-local-agent pnpm dev:trigger`. Only use that override
   when the request path is configured to target the same Trigger.dev branch.

### Agent runtime health

`GET /api/health/trigger-agent-mode` serves the most recent synthetic Trigger
execution check from shared Redis storage. The authenticated Vercel cron at
`/api/cron/trigger-health` runs once a minute, dispatches `agent-health-probe`,
and verifies its completed output within 40 seconds. The task uses the Agent
worker deployment and machine size but does not call a model, start a sandbox,
or read customer data. This measures dispatch and worker execution, not a full
Agent conversation, Agent-specific queue health, or browser streaming.

The existing Better Stack monitor can keep its URL, 30-second request timeout,
and required keyword `"ok":true`. Only a successful probe returns 200. A failed
run, unavailable evidence, or a probe timestamp older than three minutes returns
503, with distinct error categories. A report timeout cannot mark execution as
down. A stopped collector or unavailable Redis cannot silently appear healthy.
Public requests only read Redis; they never create tasks or fetch reports.

The same collector independently refreshes Trigger's one-hour health report.
`GET /api/health/trigger-reports` exposes that diagnostic signal separately:
healthy/degraded returns 200, failing/unknown returns 503. For transient report
retrieval failures, the previous report may be served for at most five minutes
from its **original generatedAt**, with `refreshError` showing the failed
refresh. Explicit failing/unknown reports replace older results immediately.
Expired data means reporting evidence is unavailable; it does not prove an
Agent outage. Use a separately named reporting monitor for this URL if alerts
on telemetry availability or report findings are wanted.

Both environments require their own `TRIGGER_SECRET_KEY` (or SDK fallback
`TRIGGER_ACCESS_TOKEN`) and existing Upstash REST URL/token. API URL and branch
selection match the Agent SDK. Restricted Trigger credentials need task trigger,
run read, and report `read:query` permissions. Redis keys and collection leases
are separated by target credentials, branch, API URL, and Vercel environment /
project. Credentials, run IDs, nonces, report metrics, and raw upstream errors
are never returned publicly. No credential transfer between environments is
needed.

Deploy the Trigger task before relying on the new monitor. Vercel cron runs only
in Production and requires `CRON_SECRET`; Preview verification must invoke the
collector with that Preview environment's cron authorization after its Trigger
branch deploys. Confirm the designated environment mapping before doing so.
Verify the actual Preview URL and `hackerai.co` independently: a successful
collector call should lead to `source: "trigger_probe"`, `status: "healthy"`,
and a recent `checkedAt`. Until the first collection, the endpoint returns
`health_data_unavailable`. If collection stops, it must return
`health_data_stale` after three minutes. Synthetic checks create up to one short
run per minute per actively collected environment and incur normal Trigger usage.
