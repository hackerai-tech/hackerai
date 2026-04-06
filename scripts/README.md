# Development Scripts

This directory contains utility scripts for local development and testing.

## Rate Limit Management

### Reset Rate Limits

Use the `reset-rate-limit.ts` script to clear rate limit counters for test users during local development.

#### Quick Start

```bash
# Reset rate limits for a specific test user tier
pnpm rate-limit:reset free
pnpm rate-limit:reset pro
pnpm rate-limit:reset ultra

# Reset all test users at once
pnpm rate-limit:reset --all

# Reset by email address
pnpm rate-limit:reset user@example.com
```

#### Usage

```bash
pnpm rate-limit:reset <user>
pnpm rate-limit:reset --all
```

**Arguments:**

- `user` - Test user tier (`free` | `pro` | `ultra`) or an email address

**Options:**

- `--all` - Reset rate limits for all test users
- `--help`, `-h` - Show help message

#### How It Works

The script looks up the user's WorkOS ID, then deletes all matching Redis keys (`*{userId}*`) to reset their rate limits.

Rate limits are stored in Upstash Redis. The script requires both WorkOS and Redis credentials.

#### Configuration

The script requires Upstash Redis and WorkOS to be configured in `.env.local`:

```env
UPSTASH_REDIS_REST_URL=https://your-endpoint.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_token_here
WORKOS_API_KEY=your_key_here
WORKOS_CLIENT_ID=your_client_id_here
```

If Redis is not configured, rate limiting is automatically disabled in local development.

#### Rate Limit Settings

Two different strategies are used based on subscription tier:

**Free tier — Fixed daily window (resets at midnight UTC):**

- Ask mode: 10 requests per day (configure via `FREE_RATE_LIMIT_REQUESTS`)
- Agent mode (local sandbox only): 5 requests per day (configure via `FREE_AGENT_RATE_LIMIT_REQUESTS`)

**Paid tiers — Cost-based token bucket (monthly, shared across all modes):**

- Pro: $25/month budget
- Pro+: $60/month budget
- Ultra: $200/month budget
- Team: $40/month budget

Token costs are calculated per request based on model pricing and actual token usage, then deducted from the monthly budget. The budget refills every 30 days. Paid users can also enable extra usage (prepaid balance) when their monthly budget is exceeded.

## Other Scripts

### Test User Management

```bash
# Create test users for e2e tests
pnpm test:e2e:users:create

# Delete test users
pnpm test:e2e:users:delete

# Reset test user passwords
pnpm test:e2e:users:reset-passwords
```

### E2B Sandbox Management

```bash
# Build development E2B sandbox
pnpm e2b:build:dev

# Build production E2B sandbox
pnpm e2b:build:prod
```

### S3 Security Validation

```bash
# Validate S3 security configuration
pnpm s3:validate
```
