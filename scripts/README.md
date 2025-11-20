# Development Scripts

This directory contains utility scripts for local development and testing.

## Rate Limit Management

### Reset Rate Limits

Use the `reset-rate-limit.ts` script to clear rate limit counters for users during local development.

#### Quick Start

```bash
# Reset all rate limits for a user
pnpm rate-limit:reset --all user_01234567

# List current rate limits
pnpm rate-limit:reset --list user_01234567

# Reset specific mode and tier
pnpm rate-limit:reset user_01234567 ask free
```

#### Usage

```bash
pnpm rate-limit:reset <userId> [mode] [subscription]
```

**Arguments:**

- `userId` - WorkOS user ID (required)
- `mode` - Chat mode: `ask` | `agent` (optional)
- `subscription` - Subscription tier: `free` | `pro` | `ultra` | `team` (optional)

**Options:**

- `--all` - Reset all rate limits for a user
- `--list` - List current rate limits for a user
- `--help` - Show help message

#### Examples

```bash
# Reset all rate limits (all modes and tiers)
pnpm rate-limit:reset --all user_01234567

# Reset all ask mode rate limits (all tiers)
pnpm rate-limit:reset user_01234567 ask

# Reset only ask mode for free tier
pnpm rate-limit:reset user_01234567 ask free

# List current rate limit keys
pnpm rate-limit:reset --list user_01234567
```

#### How It Works

Rate limits are stored in Upstash Redis with keys in this format:

```
{userId}:{mode}:{subscription}
```

Example: `user_01234567:ask:free`

The script directly deletes these keys from Redis, immediately resetting the rate limit counter to 0.

#### Configuration

The script requires Upstash Redis to be configured in `.env.local`:

```env
UPSTASH_REDIS_REST_URL=https://your-endpoint.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_token_here
```

If Redis is not configured, rate limiting is automatically disabled in local development.

#### Finding User IDs

To find a user's WorkOS ID:

1. Check the browser's developer console after signing in
2. Query the Convex database users table
3. Check the `.env.e2e` file for test user IDs

#### Rate Limit Settings

Default rate limits per 5-hour window:

**Ask Mode:**

- Free: 10 requests
- Pro: 80 requests
- Ultra: 240 requests
- Team: 160 requests

**Agent Mode:**

- Pro: 45 requests
- Ultra: 135 requests
- Team: 90 requests

Configure in `.env.local`:

```env
FREE_RATE_LIMIT_REQUESTS=10
PRO_RATE_LIMIT_REQUESTS=80
ULTRA_RATE_LIMIT_REQUESTS=240
TEAM_RATE_LIMIT_REQUESTS=160
AGENT_MODE_RATE_LIMIT_REQUESTS=45
ULTRA_AGENT_MODE_RATE_LIMIT_REQUESTS=135
TEAM_AGENT_MODE_RATE_LIMIT_REQUESTS=90
```

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
