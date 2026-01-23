# Wide Event Logging Guide

Based on: "Logging sucks. And here's how to make it better." by Boris Tane

## The Problem

Traditional logging is broken:

- Multiple log lines per request (17+ lines for one checkout)
- No correlation between events
- String search treats logs as "bags of characters"
- Optimized for writing, not querying
- Missing business context

## The Solution: Wide Events / Canonical Log Lines

**One comprehensive log event per request per service** containing everything needed for debugging.

## Key Concepts

### 1. High Cardinality Fields (Most Valuable for Debugging)

Fields with many unique values - these are what you actually search for:

- `user_id` - millions of unique values
- `request_id` - unique per request
- `chat_id` - unique per conversation
- `trace_id` - for distributed tracing

### 2. High Dimensionality

Many fields per event (30-50+). More dimensions = more questions you can answer.

### 3. Wide Event Structure

```json
{
  "timestamp": "2025-01-15T10:23:45.612Z",
  "request_id": "req_8bf7ec2d",

  "service": "checkout-service",
  "version": "2.4.1",

  "method": "POST",
  "path": "/api/checkout",
  "status_code": 500,
  "duration_ms": 1247,

  "user": {
    "id": "user_456",
    "subscription": "premium",
    "lifetime_value_cents": 284700
  },

  "error": {
    "type": "PaymentError",
    "code": "card_declined",
    "message": "Card declined by issuer"
  },

  "feature_flags": {
    "new_checkout_flow": true
  }
}
```

## Implementation Pattern

### 1. Initialize at Request Start

```typescript
const logger = createLogger("service-name");
logger.setChatId(chatId);
logger.setUser({ id: userId, subscription });
```

### 2. Build Context Throughout Request

```typescript
// After auth
logger.setUser({ subscription: user.plan });

// After rate limit check
logger.setRateLimit({ remaining, limit });

// After processing
logger.setUsage({ input_tokens, output_tokens });
```

### 3. Emit Once at End

```typescript
// Success
logger.setOutcome({ status: "success", finish_reason });
logger.setTiming({ duration_ms: Date.now() - startTime });
logger.info("Request completed");

// Error
logger.setOutcome({ status: "error", error_type, error_message });
logger.error("Request failed");
```

## Tail-Based Sampling

Make sampling decisions AFTER request completes based on outcome:

```typescript
function shouldSample(event): boolean {
  // Always keep errors
  if (event.status >= 500) return true;
  if (event.error) return true;

  // Always keep slow requests (above p99)
  if (event.duration_ms > 2000) return true;

  // Always keep important users
  if (event.user?.subscription === "enterprise") return true;

  // Random sample the rest (1-5%)
  return Math.random() < 0.05;
}
```

## What NOT to Do

1. **Don't log multiple times per request** - correlating events is hard
2. **Don't use string search** - use structured queries
3. **Don't just add OpenTelemetry** - it's plumbing, not context
4. **Don't log without business context** - user tier, feature flags, etc.

## Queries You Can Run

With wide events, debugging becomes SQL:

```sql
-- Error rate by subscription tier
SELECT user.subscription, COUNT(*) as errors
FROM events
WHERE outcome.status = 'error'
GROUP BY user.subscription

-- P99 latency by endpoint
SELECT request.path, PERCENTILE(timing.duration_ms, 0.99) as p99
FROM events
GROUP BY request.path

-- Find user's recent requests
SELECT * FROM events
WHERE user.id = 'user_456'
ORDER BY timestamp DESC
LIMIT 10
```

## Summary

| Old Way                  | Wide Events                 |
| ------------------------ | --------------------------- |
| 17 log lines per request | 1 event per request         |
| grep for user ID         | SQL query with filters      |
| Missing context          | Full business context       |
| Duplicated fields        | Single source of truth      |
| Hard to correlate        | request_id links everything |
