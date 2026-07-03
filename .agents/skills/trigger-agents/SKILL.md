---
name: trigger-agents
description: AI agent patterns with Trigger.dev - chat.agent, Sessions, AI Prompts, Trigger Agent Skills, orchestration, parallelization, routing, evaluator-optimizer, and human-in-the-loop. Use when building LLM-powered tasks that need durable AI chat, parallel workers, approval gates, tool calling, or multi-step agent workflows.
---

# AI Agent Patterns with Trigger.dev

Build production-ready AI agents using Trigger.dev's durable execution.

## Trigger.dev 4.5 Agent Surfaces

Use the new 4.5 agent primitives when they match the shape of the work:

```text
Need to...                              → Use
────────────────────────────────────────────────────────────
Build a durable AI SDK chat UI          → chat.agent
Resume one stream across run swaps      → Sessions
Version and dashboard-override prompts  → AI Prompts
Bundle procedural instructions/scripts  → Trigger Agent Skills
Run parallel local agent worktrees      → Dev branches
```

### Durable chat agents

For AI chat surfaces backed by the Vercel AI SDK, prefer `chat.agent` over a
hand-rolled API route. A chat agent is one long-lived Trigger.dev task per
conversation, keyed by chat id, with durable session streams for refresh,
redeploy, crash, idle, and reconnect behavior.

```typescript
import { chat } from "@trigger.dev/sdk/ai";
import { streamText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

export const myChat = chat.agent({
  id: "my-chat",
  run: async ({ messages, signal }) => {
    return streamText({
      // Spread first: this wires prompt, compaction, steering, skills,
      // background injection, and telemetry into the AI SDK call.
      ...chat.toStreamTextOptions(),
      model: anthropic("claude-sonnet-4-5"),
      messages,
      abortSignal: signal,
      stopWhen: stepCountIs(15),
    });
  },
});
```

Frontend integration uses `useTriggerChatTransport` from
`@trigger.dev/sdk/chat/react` and passes that transport to `useChat`. Do not
build a parallel streaming protocol unless `useTriggerChatTransport` cannot fit
the product surface.

```tsx
import { useChat } from "@ai-sdk/react";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import type { myChat } from "@/trigger/chat";

export function Chat() {
  const transport = useTriggerChatTransport<typeof myChat>({
    task: "my-chat",
    accessToken: ({ chatId }) => mintChatAccessToken(chatId),
    startSession: ({ chatId, clientData }) =>
      startChatSession({ chatId, clientData }),
  });

  const { messages, sendMessage, stop, status } = useChat({ transport });
}
```

### Sessions

Use the raw `sessions` API when the interaction is not quite chat-shaped but
still needs durable bidirectional streaming across runs. A Session is the stable
identity; runs can suspend, crash, upgrade, or be replaced while `.in` and `.out`
continue under the same external id.

```typescript
import { sessions, task } from "@trigger.dev/sdk";

export const inboxAgent = task({
  id: "inbox-agent",
  run: async (payload: { sessionId: string }) => {
    const session = sessions.open(payload.sessionId);

    while (true) {
      const next = await session.in.wait<{ text: string }>({ timeout: "1h" });
      if (!next.ok) return;
      await session.out.append({ type: "reply", text: `echo: ${next.output.text}` });
    }
  },
});
```

### AI Prompts

Use `prompts.define()` when prompt text or model choice should be versioned on
deploy and optionally overridden from the Trigger.dev dashboard. Resolve the
prompt in a lifecycle hook, store it with `chat.prompt.set()`, then let
`chat.toStreamTextOptions()` apply the system prompt, model/config, and
telemetry.

```typescript
import { prompts } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { createProviderRegistry, streamText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const registry = createProviderRegistry({ anthropic });

const systemPrompt = prompts.define({
  id: "my-chat-system",
  model: "anthropic:claude-sonnet-4-5",
  variables: z.object({ name: z.string() }),
  content: "You are a helpful assistant for {{name}}.",
});

export const myChat = chat.agent({
  id: "my-chat",
  onChatStart: async ({ clientData }) => {
    chat.prompt.set(await systemPrompt.resolve({ name: clientData.name }));
  },
  run: async ({ messages, signal }) => {
    return streamText({
      ...chat.toStreamTextOptions({ registry }),
      messages,
      abortSignal: signal,
      stopWhen: stepCountIs(15),
    });
  },
});
```

### Trigger Agent Skills

Use Trigger Agent Skills for reusable folders of instructions plus optional
scripts/references/assets that a `chat.agent` loads on demand. Skills are
developer-authored code bundled into the deploy image; never accept skill paths
from untrusted input.

```typescript
import { skills } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const pdfSkill = skills.define({
  id: "pdf-processing",
  path: "./skills/pdf-processing",
});

export const docsChat = chat.agent({
  id: "docs-chat",
  onChatStart: async () => {
    chat.skills.set([await pdfSkill.local()]);
  },
  run: async ({ messages, signal }) => {
    return streamText({
      ...chat.toStreamTextOptions(),
      model: anthropic("claude-sonnet-4-5"),
      messages,
      abortSignal: signal,
    });
  },
});
```

`chat.toStreamTextOptions()` injects a short available-skills list plus scoped
`loadSkill`, `readFile`, and `bash` tools. The model should call `loadSkill`
before using a skill, then use the scoped tools against that skill's folder.

### Dev branches

Trigger.dev 4.5 supports isolated local dev branches. Use
`trigger dev --branch <name>` or set `TRIGGER_DEV_BRANCH`. In this repo,
`pnpm dev:trigger` derives a branch name from git and passes it through so
parallel worktrees or coding agents do not collide in the default dev
environment.

### HackerAI migration note

For HackerAI Agent mode, treat `chat.agent` as migration input, not a drop-in
replacement. A live migration must preserve auth/suspension, sandbox setup,
billing/refunds, budget monitoring, fallback models, todos, Convex persistence,
and browser reconnect/resume behavior before swapping the current Agent stack.

## Pattern Selection

```text
Need to...                              → Use
─────────────────────────────────────────────────────
Build a durable Vercel AI SDK chat      → chat.agent
Stream a non-chat agent inbox           → Sessions
Bundle agent instructions/scripts       → Trigger Agent Skills
Process items in parallel               → Parallelization
Route to different models/handlers      → Routing
Chain steps with validation gates       → Prompt Chaining
Coordinate multiple specialized tasks   → Orchestrator-Workers
Self-improve until quality threshold    → Evaluator-Optimizer
Pause for human approval                → Human-in-the-Loop (waitpoints.md)
Stream progress to frontend             → Realtime Streams (streaming.md)
Let LLM call your tasks as tools        → ai.tool (ai-tool.md)
```

---

## Core Patterns

### 1. Prompt Chaining (Sequential with Gates)

Chain LLM calls with validation between steps. Fail early if intermediate output is bad.

```typescript
import { task } from "@trigger.dev/sdk";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

export const translateCopy = task({
  id: "translate-copy",
  run: async ({ text, targetLanguage, maxWords }) => {
    // Step 1: Generate
    const draft = await generateText({
      model: openai("gpt-4o"),
      prompt: `Write marketing copy about: ${text}`,
    });

    // Gate: Validate before continuing
    const wordCount = draft.text.split(/\s+/).length;
    if (wordCount > maxWords) {
      throw new Error(`Draft too long: ${wordCount} > ${maxWords}`);
    }

    // Step 2: Translate (only if gate passed)
    const translated = await generateText({
      model: openai("gpt-4o"),
      prompt: `Translate to ${targetLanguage}: ${draft.text}`,
    });

    return { draft: draft.text, translated: translated.text };
  },
});
```

---

### 2. Routing (Classify → Dispatch)

Use a cheap model to classify, then route to appropriate handler.

```typescript
import { task } from "@trigger.dev/sdk";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const routingSchema = z.object({
  model: z.enum(["gpt-4o", "o1-mini"]),
  reason: z.string(),
});

export const routeQuestion = task({
  id: "route-question",
  run: async ({ question }) => {
    // Cheap classification call
    const routing = await generateText({
      model: openai("gpt-4o-mini"),
      messages: [
        {
          role: "system",
          content: `Classify question complexity. Return JSON: {"model": "gpt-4o" | "o1-mini", "reason": "..."}
          - gpt-4o: simple factual questions
          - o1-mini: complex reasoning, math, code`,
        },
        { role: "user", content: question },
      ],
    });

    const { model } = routingSchema.parse(JSON.parse(routing.text));

    // Route to selected model
    const answer = await generateText({
      model: openai(model),
      prompt: question,
    });

    return { answer: answer.text, routedTo: model };
  },
});
```

---

### 3. Parallelization

Run independent LLM calls simultaneously with `batch.triggerByTaskAndWait`.

```typescript
import { batch, task } from "@trigger.dev/sdk";

export const analyzeContent = task({
  id: "analyze-content",
  run: async ({ text }) => {
    // All three run in parallel
    const { runs: [sentiment, summary, moderation] } = await batch.triggerByTaskAndWait([
      { task: analyzeSentiment, payload: { text } },
      { task: summarizeText, payload: { text } },
      { task: moderateContent, payload: { text } },
    ]);

    // Check moderation first
    if (moderation.ok && moderation.output.flagged) {
      return { error: "Content flagged", reason: moderation.output.reason };
    }

    return {
      sentiment: sentiment.ok ? sentiment.output : null,
      summary: summary.ok ? summary.output : null,
    };
  },
});
```

**See:** `references/orchestration.md` for advanced patterns

---

### 4. Orchestrator-Workers (Fan-out/Fan-in)

Orchestrator extracts work items, fans out to workers, aggregates results.

```typescript
import { batch, task } from "@trigger.dev/sdk";

export const factChecker = task({
  id: "fact-checker",
  run: async ({ article }) => {
    // Step 1: Extract claims (sequential - need output first)
    const { runs: [extractResult] } = await batch.triggerByTaskAndWait([
      { task: extractClaims, payload: { article } },
    ]);

    if (!extractResult.ok) throw new Error("Failed to extract claims");
    const claims = extractResult.output;

    // Step 2: Fan-out - verify all claims in parallel
    const { runs } = await batch.triggerByTaskAndWait(
      claims.map(claim => ({ task: verifyClaim, payload: claim }))
    );

    // Step 3: Fan-in - aggregate results
    const verified = runs
      .filter((r): r is typeof r & { ok: true } => r.ok)
      .map(r => r.output);

    return { claims, verifications: verified };
  },
});
```

---

### 5. Evaluator-Optimizer (Self-Refining Loop)

Generate → Evaluate → Retry with feedback until approved.

```typescript
import { task } from "@trigger.dev/sdk";

export const refineTranslation = task({
  id: "refine-translation",
  run: async ({ text, targetLanguage, feedback, attempt = 0 }) => {
    // Bail condition
    if (attempt >= 5) {
      return { text, status: "MAX_ATTEMPTS", attempts: attempt };
    }

    // Generate (with feedback if retrying)
    const prompt = feedback
      ? `Improve this translation based on feedback:\n${feedback}\n\nOriginal: ${text}`
      : `Translate to ${targetLanguage}: ${text}`;

    const translation = await generateText({
      model: openai("gpt-4o"),
      prompt,
    });

    // Evaluate
    const evaluation = await generateText({
      model: openai("gpt-4o"),
      prompt: `Evaluate translation quality. Reply APPROVED or provide specific feedback:\n${translation.text}`,
    });

    if (evaluation.text.includes("APPROVED")) {
      return { text: translation.text, status: "APPROVED", attempts: attempt + 1 };
    }

    // Recursive self-call with feedback
    return refineTranslation.triggerAndWait({
      text,
      targetLanguage,
      feedback: evaluation.text,
      attempt: attempt + 1,
    }).unwrap();
  },
});
```

---

## Trigger-Specific Features

| Feature | What it enables | Reference |
|---------|-----------------|-----------|
| **chat.agent** | Durable AI SDK chat, reconnect/resume, lifecycle hooks | Trigger.dev AI Chat docs |
| **Sessions** | Durable bidirectional streams across run boundaries | Trigger.dev Sessions docs |
| **AI Prompts** | Versioned prompts with dashboard overrides | Trigger.dev Prompts docs |
| **Agent Skills** | On-demand instructions/scripts bundled into chat agents | Trigger.dev Agent Skills docs |
| **Dev branches** | Isolated local Trigger.dev sessions for worktrees/agents | `trigger dev --branch <name>` |
| **Waitpoints** | Human approval gates, external callbacks | `references/waitpoints.md` |
| **Streams** | Real-time progress to frontend | `references/streaming.md` |
| **ai.tool** | Let LLMs call your tasks as tools | `references/ai-tool.md` |
| **batch.triggerByTaskAndWait** | Typed parallel execution | `references/orchestration.md` |

---

## Error Handling

```typescript
const { runs } = await batch.triggerByTaskAndWait([...]);

// Check individual results
for (const run of runs) {
  if (run.ok) {
    console.log(run.output);  // Typed output
  } else {
    console.error(run.error);  // Error details
    console.log(run.taskIdentifier);  // Which task failed
  }
}

// Or filter by task type
const verifications = runs
  .filter((r): r is typeof r & { ok: true } =>
    r.ok && r.taskIdentifier === "verify-claim"
  )
  .map(r => r.output);
```

---

## Quick Reference

```typescript
// Trigger and wait for result
const result = await myTask.triggerAndWait(payload);
if (result.ok) console.log(result.output);

// Batch trigger same task
const results = await myTask.batchTriggerAndWait([
  { payload: item1 },
  { payload: item2 },
]);

// Batch trigger different tasks (typed)
const { runs } = await batch.triggerByTaskAndWait([
  { task: taskA, payload: { foo: 1 } },
  { task: taskB, payload: { bar: "x" } },
]);

// Self-recursion with unwrap
return myTask.triggerAndWait(newPayload).unwrap();
```
