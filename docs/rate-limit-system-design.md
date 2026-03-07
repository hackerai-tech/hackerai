# HackerAI Rate Limit System Design

> **Goal**: Build a rate limiting system that users love while ensuring we never spend more than $N per user on inference tokens.

## Table of Contents

1. [Research: What Users Actually Want](#research-what-users-actually-want)
2. [Research: What Competitors Get Wrong](#research-what-competitors-get-wrong)
3. [Design Principles](#design-principles)
4. [System Architecture](#system-architecture)
5. [Tier Definitions & Budgets](#tier-definitions--budgets)
6. [Smart Model Routing (The Key Innovation)](#smart-model-routing-the-key-innovation)
7. [Graceful Degradation Strategy](#graceful-degradation-strategy)
8. [Implementation Plan](#implementation-plan)
9. [Migration from Current System](#migration-from-current-system)

---

## Research: What Users Actually Want

Based on deep research into Cursor, Windsurf, Claude Code, GitHub Copilot communities (Reddit, forums, HN, X):

### The #1 Pain Point: "Token Anxiety"

Users describe a phenomenon called **"token anxiety"** — the psychological burden of watching a usage meter tick while coding. This kills flow state, which is the entire value proposition of AI coding tools.

> _"The second I could see the meter ticking, something in me flinched... every time I hovered over 'Send,' I felt an internal hesitation."_ — [Medium: Token Anxiety](https://medium.com/illumination/token-anxiety-how-real-time-ai-pricing-is-killing-developer-flow-883dc6612ff7)

### The Top 5 User Demands

| Priority | What Users Want | What They Hate |
|----------|----------------|----------------|
| 1 | **Predictable costs** — know exactly what they'll pay | Surprise bills, unclear credit systems |
| 2 | **Never get completely blocked** — always be able to code | Hard walls that stop them mid-session |
| 3 | **Transparent limits** — clear visibility into usage | Silent throttling, hidden rate limits |
| 4 | **Fair value for money** — get what they paid for | Paying $20 but only getting $8 of actual value |
| 5 | **Smooth degradation** — slower is better than stopped | Binary on/off limits with no middle ground |

### Key Incidents That Shaped User Expectations

- **Cursor June 2025**: Switched from 500 requests to ~225 credits at same $20/mo price. CEO had to publicly apologize. Users felt "rug-pulled." Billing complaints now dominate their Reddit/Trustpilot/G2.
- **GitHub Copilot "Premium Requests"**: Introduced 300 premium request limits. Users reported hitting limits in 4-5 days. Community discussion #164026 had hundreds of frustrated developers.
- **Cursor "Unlimited" Plan**: Marketed as unlimited but had rate limits after 5 requests/hour. Users called it "more limited than the limited plan."

### What Users Praise

- **Claude Code Max weekly limits**: Users appreciate limits that reset on a predictable cadence (weekly) rather than monthly — smaller buckets feel more forgiving.
- **Flat-rate predictability**: One developer noted _"Spending around $30 for a year of unlimited use... I don't have to worry about using a lesser model or running out of tokens. I just get to keep trucking."_
- **GitHub Copilot's $10/mo unlimited autocomplete**: Despite limitations, the predictable flat rate with unlimited basic completions is highly valued.

---

## Research: What Competitors Get Wrong

### Cursor's Mistakes
1. **Opaque credit system** — users can't map credits to actual work done
2. **No live usage tracker** at launch — users couldn't see how much was consumed
3. **"Unlimited" marketing with hidden limits** — worst possible trust violation
4. **Credit burn varies wildly by model** — Claude costs 2x+ more than Gemini, not clearly communicated
5. **Monthly billing cycle** — run out day 5, blocked for 25 days

### Windsurf's Approach (Better, Not Perfect)
1. Cheaper base price ($15/mo) creates goodwill
2. Still uses opaque "credits" system
3. Premium models burn 2x credits — at least it's documented
4. Unlimited tab completions (smart — the cheap stuff is free)

### Claude Code's Approach (Most Honest, Least Accessible)
1. Pay-per-token is transparent but scary for budgeting
2. Pro ($20) + Max ($100/$200) tiers give clear ceiling
3. Weekly limit resets feel fair (praised by community)
4. But heavy users report $200-300/mo actual costs — sticker shock

---

## Design Principles

Based on all research, our system should follow these principles:

### 1. "Never Blocked, Sometimes Slower"
Users should **never** hit a hard wall and be unable to code. Instead, they experience graceful degradation — the AI gets a bit less capable but keeps working.

### 2. "Pay for Ceiling, Not for Floor"
Subscription price = the maximum you'll pay. No surprise overages. Extra usage is always opt-in and explicitly budgeted.

### 3. "Transparent Down to the Dollar"
Show users exactly how much of their budget they've used, in dollars — not opaque "credits" or "points." Internally we track points, but the UI shows `$4.20 / $25.00 used this period`.

### 4. "Short Reset Cycles"
Session (5-hour) and weekly limits are better than monthly. If a user burns through a day's budget in 2 hours of intense work, they can come back in 3 hours with a fresh session. Monthly budgets that run out on day 5 are unacceptable.

### 5. "Smart, Not Stingy"
Use cheaper models for routine tasks automatically, save expensive models for when they matter. The user gets MORE done for the same cost.

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      User Request                            │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                   Request Classifier                         │
│                                                              │
│  Analyzes request complexity:                                │
│  • Simple (autocomplete, small edits, quick questions)       │
│  • Standard (code generation, explanations, refactoring)     │
│  • Complex (multi-file agent tasks, architecture, debugging) │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                   Budget Controller                          │
│                                                              │
│  1. Check user's remaining budget (session + weekly)         │
│  2. Determine budget zone: GREEN / YELLOW / ORANGE / RED     │
│  3. Apply model routing rules based on zone + complexity     │
│  4. Pre-deduct estimated cost                                │
│  5. Post-reconcile with actual cost (refund if overcharged)  │
└──────────┬───────────────┬───────────────┬───────────────────┘
           │               │               │
     ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
     │  GREEN     │  │  YELLOW   │  │  RED       │
     │  Zone      │  │  Zone     │  │  Zone      │
     │            │  │           │  │            │
     │ Full model │  │ Smart     │  │ Fallback   │
     │ access     │  │ routing   │  │ models     │
     │            │  │ (cheaper  │  │ only       │
     │ User's     │  │ models    │  │            │
     │ preferred  │  │ for simple│  │ Always     │
     │ model      │  │ tasks)    │  │ available  │
     └───────────┘  └───────────┘  └────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                    Usage Tracker                              │
│                                                              │
│  • Redis token buckets (existing Upstash infrastructure)     │
│  • Session bucket: refills every 5 hours                     │
│  • Weekly bucket: refills every 7 days                       │
│  • Real-time usage dashboard data via Convex                 │
│  • Proactive warnings at 50%, 75%, 90% thresholds           │
└──────────────────────────────────────────────────────────────┘
```

---

## Tier Definitions & Budgets

### Cost Control: The $N Budget Cap

The core constraint: **for each tier, we must not spend more than the subscription price on inference costs.** We target a healthy margin:

| Tier | Monthly Price | Max Inference Budget | Target Margin | Daily Budget | Weekly Budget |
|------|-------------|---------------------|---------------|-------------|--------------|
| **Free** | $0 | $0.50/mo (loss leader) | -100% | ~$0.017 | ~$0.12 |
| **Pro** | $25/mo | $20/mo | 20% | ~$0.67 | ~$4.67 |
| **Pro+** | $60/mo | $50/mo | 17% | ~$1.67 | ~$11.67 |
| **Ultra** | $200/mo | $160/mo | 20% | ~$5.33 | ~$37.33 |
| **Team** | $40/user/mo | $32/user/mo | 20% | ~$1.07 | ~$7.47 |

### How This Translates to Real Usage (Pro @ $25/mo)

With smart model routing, a Pro user gets approximately:

| Task Type | Model Used | Cost/Request | Requests/Day | Requests/Week |
|-----------|-----------|-------------|-------------|---------------|
| Quick questions | Gemini Flash / Grok | ~$0.002 | ~100+ | ~700+ |
| Code generation | Sonnet 4.6 | ~$0.02-0.05 | ~15-30 | ~100-200 |
| Complex agent tasks | Sonnet 4.6 / GPT-5.4 | ~$0.10-0.30 | ~3-5 | ~20-30 |

**This is comparable or better than Cursor Pro** (~225 Sonnet requests) because we route simple tasks to cheaper models automatically.

---

## Smart Model Routing (The Key Innovation)

This is what differentiates us from Cursor's "burn credits on everything equally" approach.

### Request Complexity Classification

```typescript
type RequestComplexity = "simple" | "standard" | "complex";

interface ClassificationSignals {
  // Message signals
  messageLength: number;          // Short messages → likely simple
  conversationTurns: number;      // Long conversations → likely complex
  hasCodeContext: boolean;         // Code attached → standard+
  codeContextSize: number;        // Large context → complex

  // Intent signals
  isFollowUp: boolean;            // Follow-ups are often simple
  hasMultiFileScope: boolean;     // Multi-file → complex
  isAgentMode: boolean;           // Agent mode → standard+

  // Historical signals
  userModelPreference?: string;   // User explicitly chose a model
  taskCategory?: string;          // "explain", "generate", "debug", "refactor"
}
```

### Model Routing Rules

```
┌─────────────────────────────────────────────────────────────┐
│                    Model Routing Matrix                       │
├─────────────┬──────────────┬──────────────┬─────────────────┤
│ Complexity  │ GREEN Zone   │ YELLOW Zone  │ RED Zone        │
│             │ (>50% left)  │ (10-50% left)│ (<10% left)     │
├─────────────┼──────────────┼──────────────┼─────────────────┤
│ Simple      │ Flash/Grok   │ Flash/Grok   │ Flash/Grok      │
│             │ ($0.001-0.003)│($0.001-0.003)│ ($0.001-0.003) │
├─────────────┼──────────────┼──────────────┼─────────────────┤
│ Standard    │ User's pick  │ Smart swap*  │ Flash/Grok      │
│             │ (any model)  │ (cheaper alt)│ ($0.001-0.003)  │
├─────────────┼──────────────┼──────────────┼─────────────────┤
│ Complex     │ User's pick  │ User's pick  │ Smart swap*     │
│             │ (any model)  │ (any model)  │ (cheaper alt)   │
└─────────────┴──────────────┴──────────────┴─────────────────┘

* Smart swap: Use a cheaper model that's still good for the task.
  E.g., Gemini Pro instead of Sonnet 4.6 for code generation.
  Grok 4.1 for quick edits instead of GPT-5.4.
```

### User Override: Always Respect Choice

**Critical UX rule**: Users can always force a specific model. If they explicitly select Sonnet 4.6 and are in RED zone, we:
1. Show a warning: "Using Sonnet 4.6 will consume ~$0.15 of your remaining $1.20"
2. Let them proceed if they confirm
3. Never silently downgrade a user's explicit model choice

Smart routing only applies to **auto/default** model selection.

---

## Graceful Degradation Strategy

### The Four Zones

```
Budget Remaining:
████████████████████████████████████████  100%
████████████████████████████████          GREEN (>50%)
                                          Full access, all models
████████████████████                      YELLOW (10-50%)
                                          Smart routing kicks in
                                          Proactive warning shown
████████                                  ORANGE (5-10%)
                                          Stronger routing to cheap models
                                          Persistent usage bar shown
██                                        RED (<5%)
                                          Fallback models only
                                          "Add extra credits" prompt
                                          But NEVER fully blocked
```

### Zone Behaviors

#### GREEN Zone (>50% remaining)
- Full access to all models
- No warnings, no restrictions
- User sees usage in settings but no in-chat indicators
- **User experience**: "I'm just coding, it's great"

#### YELLOW Zone (10-50% remaining)
- One-time toast notification: "You've used 60% of your weekly budget. Resets in 3 days."
- Smart model routing activates for auto-selected models
- Simple tasks silently use cheaper models (user won't notice — autocomplete and quick answers are just as good on Flash)
- Explicit model choices still honored
- **User experience**: "Got a heads up, makes sense, I'll be a bit more intentional"

#### ORANGE Zone (5-10% remaining)
- Persistent subtle usage bar appears in chat header
- Stronger model routing — standard tasks also go to cheaper models
- Show "Add extra usage credits" option (not aggressive upsell, just available)
- **User experience**: "Running low, but I can still work"

#### RED Zone (<5% remaining)
- Fallback models only (Gemini Flash, Grok 4.1) unless user explicitly overrides
- Clear message: "Budget low — using fast models to keep you coding. Resets in [time] or add credits."
- **THE KEY POINT**: User can still code. They still get AI assistance. It's just less powerful.
- Extra usage credits (existing system) available for those who want to keep going at full power
- **User experience**: "Less powerful but I'm not blocked. I know when it resets."

#### EMPTY (0% remaining, no extra credits)
- Absolute fallback: **tiny, near-free model responses** for basic tasks
- Very limited (short responses, no agent mode, basic autocomplete only)
- Budget for this: ~$0.001/request, pennies per day
- Message: "Your budget has been fully used. Resets in [time]. Add credits for full access now."
- **User experience**: "Very limited, but not a brick wall. I can still get small things done."

---

## Extra Usage (Opt-In Overflow)

The existing extra usage system is well-designed. Key enhancements:

### Current System (Keep)
- Prepaid balance with auto-reload
- 1.1x multiplier (fair markup for overflow)
- Monthly spending cap
- Auto-reload threshold triggers

### Proposed Enhancements

#### 1. "Smart Extra Usage" Mode
Instead of immediately deducting from extra balance when limits hit, offer:
- **Option A**: "Use cheaper models" (free, stays within subscription)
- **Option B**: "Use extra credits for full power" (deducts from balance)

This gives users control rather than silently burning their prepaid balance.

#### 2. Usage Forecasting
Show users a projection:
> "At your current pace, you'll use ~$18 of your $25 budget this week. You're on track."

Or if burning fast:
> "You've used $10 today (usually $3/day). At this rate, you may hit limits by Wednesday. Want to slow down model selection?"

#### 3. "Budget-Aware Agent Mode"
Agent mode is the biggest cost driver. When an agent task starts:
- Estimate total cost: "This agent task will cost approximately $0.50-1.50"
- Show remaining budget context: "You have $12.30 remaining this week"
- Let user choose intensity: "Fast & cheap" vs "Thorough & premium"

---

## UI/UX: How Users See This

### Settings Page: Usage Dashboard

```
┌─────────────────────────────────────────────────┐
│  Usage This Week                                │
│                                                 │
│  ████████████████████░░░░░░░░  $16.40 / $25.00  │
│                                                 │
│  Session (resets in 2h 15m)                     │
│  ██████████████░░░░░░░░░░░░░  $0.45 / $0.83     │
│                                                 │
│  📊 Usage Breakdown                             │
│  Agent mode:    $11.20 (68%)                    │
│  Ask mode:       $4.10 (25%)                    │
│  Autocomplete:   $1.10 (7%)                     │
│                                                 │
│  📈 Trend: Using ~$3.20/day (on pace)           │
│                                                 │
│  [Add Extra Credits]  [Upgrade Plan]            │
└─────────────────────────────────────────────────┘
```

### In-Chat: Minimal, Non-Intrusive

**GREEN zone**: Nothing shown. Don't pollute the coding experience.

**YELLOW zone**: One-time dismissible toast:
```
ℹ️ 60% of weekly budget used. Resets Thursday.  [Dismiss]  [See Usage]
```

**ORANGE zone**: Subtle bar in header:
```
┌──────────────────────────────────────────┐
│  ████████░░ 15% budget remaining         │
└──────────────────────────────────────────┘
```

**RED zone**: Inline message (not a blocking modal):
```
⚡ Using fast models to save budget. Resets in 14h.  [Add Credits]
```

---

## Implementation Plan

### Phase 1: Request Classifier (Week 1-2)

Add a lightweight request complexity classifier:

```typescript
// lib/rate-limit/request-classifier.ts

export function classifyRequestComplexity(
  signals: ClassificationSignals
): RequestComplexity {
  // User explicitly chose a model → don't override
  if (signals.userModelPreference) return "complex"; // treat as complex = use their model

  // Agent mode with multi-file scope → complex
  if (signals.isAgentMode && signals.hasMultiFileScope) return "complex";

  // Short follow-up messages → simple
  if (signals.isFollowUp && signals.messageLength < 200) return "simple";

  // No code context, short message → simple
  if (!signals.hasCodeContext && signals.messageLength < 300) return "simple";

  // Large code context or agent mode → standard/complex
  if (signals.codeContextSize > 10000 || signals.isAgentMode) return "complex";

  return "standard";
}
```

### Phase 2: Budget Zone System (Week 2-3)

Enhance the existing token bucket to expose zone information:

```typescript
// lib/rate-limit/budget-zones.ts

export type BudgetZone = "green" | "yellow" | "orange" | "red" | "empty";

export function getBudgetZone(remainingPercent: number): BudgetZone {
  if (remainingPercent > 50) return "green";
  if (remainingPercent > 10) return "yellow";
  if (remainingPercent > 5) return "orange";
  if (remainingPercent > 0) return "red";
  return "empty";
}

export function getModelRoutingForZone(
  zone: BudgetZone,
  complexity: RequestComplexity,
  userModelPreference?: string,
): ModelRoutingDecision {
  // Always respect explicit user choice
  if (userModelPreference) {
    return {
      model: userModelPreference,
      isDowngraded: false,
      reason: "user_choice",
    };
  }

  // Route based on zone + complexity
  const routingMatrix: Record<BudgetZone, Record<RequestComplexity, string>> = {
    green:  { simple: "auto-cheap",  standard: "auto-default", complex: "auto-default" },
    yellow: { simple: "auto-cheap",  standard: "auto-cheap",   complex: "auto-default" },
    orange: { simple: "auto-cheap",  standard: "auto-cheap",   complex: "auto-cheap"   },
    red:    { simple: "auto-cheap",  standard: "auto-cheap",   complex: "auto-cheap"   },
    empty:  { simple: "auto-minimal",standard: "auto-minimal", complex: "blocked"      },
  };

  // ...
}
```

### Phase 3: Smart Model Router (Week 3-4)

```typescript
// lib/rate-limit/model-router.ts

// "auto-cheap" models: fast, good enough for most tasks, 5-10x cheaper
const CHEAP_MODELS = ["model-gemini-3-flash", "model-grok-4.1"];

// "auto-default" models: the best models, used when budget allows
const DEFAULT_MODELS = ["model-sonnet-4.6", "model-gpt-5.4"];

// "auto-minimal" models: near-free, for absolute fallback
const MINIMAL_MODELS = ["model-gemini-3-flash"]; // smallest/cheapest available
```

### Phase 4: Usage Dashboard UI (Week 4-5)

- Real-time usage display in settings (enhance existing `getAgentRateLimitStatus`)
- In-chat zone indicators
- Usage forecasting based on rolling average

### Phase 5: Smart Extra Usage Prompts (Week 5-6)

- "Use cheaper model" vs "Use extra credits" choice
- Agent task cost estimation before execution
- Budget-aware agent mode

---

## Migration from Current System

The current system already has solid foundations:

### What We Keep (Unchanged)
- **Upstash Redis token buckets** — session (5h) and weekly (7d) refill cycles
- **Points system** (1 point = $0.0001) — internal tracking stays the same
- **Extra usage balance** — prepaid credits with auto-reload
- **Refund mechanism** — refund on failed requests
- **Model pricing map** — per-model cost calculation

### What We Add
1. **Request classifier** — new module, no changes to existing code
2. **Budget zones** — thin wrapper around existing `getBudgetLimits` + remaining calculation
3. **Model router** — new module, called before model selection in chat handler
4. **Zone-based UI warnings** — enhance existing `RateLimitWarning` component
5. **Usage dashboard** — new settings component, uses existing `getAgentRateLimitStatus`

### What We Modify
- `checkRateLimit()` → returns zone info alongside existing data
- Chat handler → consults model router for auto model selection
- `RateLimitWarning` → shows zone-appropriate messages
- Pricing page → clearly communicates the "never blocked" promise

### Breaking Changes: None
This is entirely additive. Users on existing plans see no behavior change until we enable smart routing (feature flag).

---

## Cost Modeling & Safety

### Worst Case: "Whale User" Protection

A power user on Pro ($25/mo) who codes 8 hours/day, 5 days/week:

| Scenario | Without Smart Routing | With Smart Routing |
|----------|----------------------|-------------------|
| All Sonnet 4.6 requests | ~$80/mo (3.2x budget) | N/A |
| Mixed (current system) | ~$35/mo (1.4x budget) | N/A |
| Smart routed | N/A | ~$20/mo (0.8x budget) |

Smart routing saves 40-60% on inference costs by using Flash/Grok for the ~70% of requests that don't need frontier models.

### The Math: Why This Works

From the model pricing map:
- **Sonnet 4.6**: $3/$15 per 1M tokens (input/output)
- **Gemini Flash**: $0.5/$3 per 1M tokens (6x cheaper input, 5x cheaper output)
- **Grok 4.1**: $0.2/$0.5 per 1M tokens (15x cheaper input, 30x cheaper output)

A typical coding session might be:
- 50 simple interactions (autocomplete, quick questions): **$0.10 with Flash** vs $0.60 with Sonnet
- 15 standard tasks (code gen, explanations): **$0.30 with Flash** vs $1.50 with Sonnet
- 5 complex tasks (agent, debugging): **$0.75 with Sonnet** (still uses premium)

**Total: $1.15/day smart routed vs $2.85/day all-Sonnet** = 60% savings

At $1.15/day, a Pro user's $20 inference budget lasts the full month with room to spare.

### Hard Cap Safety

Even with smart routing, implement a hard daily cap at 2x the daily budget:
- Pro: $1.34/day hard cap (2x $0.67)
- Ultra: $10.66/day hard cap (2x $5.33)

If somehow exceeded (shouldn't happen with routing), fall to minimal models. This is the absolute "we will not spend more than N dollars" guarantee.

---

## Summary: Why Users Will Love This

| Problem (competitors) | Our Solution |
|----------------------|-------------|
| "Token anxiety" — watching the meter tick | GREEN zone shows nothing. Most users never see limits. |
| Hard walls — completely blocked mid-session | Never blocked. Graceful degradation to cheaper models. |
| Opaque credits — "what does 1 credit even mean?" | Show dollars: "$4.20 / $25.00 used this week" |
| Surprise overages — bills 2-10x expected | Subscription = ceiling. Extra usage is opt-in only. |
| Monthly reset cliff — run out day 5, wait 25 days | 5-hour session + 7-day weekly resets. Always recoverable. |
| One-size-fits-all model pricing | Smart routing: cheap models for simple tasks, premium when it matters. |
| Aggressive upselling when limits hit | Gentle, informative: "Using fast models. Resets in 3h." |

**The key insight**: Users don't care which model answers their autocomplete or explains a syntax error. They care deeply which model plans their architecture or debugs a gnarly race condition. Smart routing gives them MORE total interactions at the same cost by being intelligent about when quality matters.

---

## Appendix: Model Cost Reference

Current model pricing (from `token-bucket.ts`):

| Model | Input ($/1M) | Output ($/1M) | Category |
|-------|-------------|---------------|----------|
| Gemini Flash | $0.50 | $3.00 | Cheap |
| Grok 4.1 | $0.20 | $0.50 | Cheap |
| Kimi K2.5 | $0.60 | $3.00 | Cheap |
| Default (Ask) | $0.50 | $3.00 | Cheap |
| Gemini Pro | $2.00 | $12.00 | Mid |
| Sonnet 4.6 | $3.00 | $15.00 | Premium |
| GPT-5.4 | $2.50 | $15.00 | Premium |

"Cheap" models cost 5-30x less than premium. This is the lever that makes the whole system work.
