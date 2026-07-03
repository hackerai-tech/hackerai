---
name: trigger-setup
description: Set up Trigger.dev in your project. Use when adding Trigger.dev for the first time, creating trigger.config.ts, or initializing the trigger directory.
---

# Trigger.dev Setup

Get Trigger.dev running in your project in minutes.

## When to Use

- Adding Trigger.dev to an existing project
- Creating your first task
- Setting up trigger.config.ts
- Connecting to Trigger.dev cloud

## Prerequisites

- Node.js 18+ or Bun
- A Trigger.dev account (https://cloud.trigger.dev)

## Quick Start

### 1. Install the SDK

```bash
npm install @trigger.dev/sdk
```

### 2. Initialize Your Project

```bash
npx trigger.dev@latest init
```

This creates:
- `trigger.config.ts` - project configuration
- `trigger/` directory - where your tasks live
- `trigger/example.ts` - a sample task

### 3. Configure trigger.config.ts

```ts
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_xxxxx", // From dashboard
  dirs: ["./trigger"],
});
```

### 4. Create Your First Task

```ts
// trigger/my-task.ts
import { task } from "@trigger.dev/sdk";

export const myFirstTask = task({
  id: "my-first-task",
  run: async (payload: { name: string }) => {
    console.log(`Hello, ${payload.name}!`);
    return { message: `Processed ${payload.name}` };
  },
});
```

### 5. Start Development Server

```bash
npx trigger.dev@latest dev
```

### 6. Trigger Your Task

From your app code:

```ts
import { tasks } from "@trigger.dev/sdk";
import type { myFirstTask } from "./trigger/my-task";

await tasks.trigger<typeof myFirstTask>("my-first-task", {
  name: "World",
});
```

Or from the Trigger.dev dashboard "Test" tab.

## Project Structure

```
your-project/
├── trigger.config.ts    # Required - project config
├── trigger/             # Required - task files
│   ├── my-task.ts
│   └── another-task.ts
├── package.json
└── ...
```

## Environment Variables

Create `.env` or set in your environment:

```bash
TRIGGER_SECRET_KEY=tr_dev_xxxxx  # From dashboard > API Keys
```

## Common Issues

### "No tasks found"
- Ensure tasks are **exported** from files in `dirs` folders
- Check `trigger.config.ts` points to correct directories

### "Project not found"
- Verify `project` in config matches dashboard
- Check `TRIGGER_SECRET_KEY` is set

### "Task not registered"
- Restart `npx trigger.dev@latest dev` after adding new tasks
- Tasks must use `task()` or `schemaTask()` from `@trigger.dev/sdk`

## Updating Agent Skills

Trigger.dev 4.5 ships assistant skills for task authoring, realtime/frontends,
`chat.agent`, advanced chat-agent patterns, and cost savings. Refresh them with
the CLI when you update Trigger.dev packages:

```bash
npx trigger.dev@latest skills
```

The installer writes to native assistant skill directories, including
`.agents/skills/` for Codex CLI, Jules, and OpenCode. It can also run from the
first `trigger dev` prompt. Most installed skills read their version-pinned API
reference from `@trigger.dev/sdk` in `node_modules`, so upgrading the SDK keeps
the guidance aligned with the project version.

In this repo, `pnpm dev:trigger` starts Trigger.dev with an isolated dev branch
derived from git. Use `TRIGGER_DEV_BRANCH=<name> pnpm dev:trigger` when you need
an explicit branch name for parallel local agents or worktrees.

## Next Steps

- Add retry logic → see **trigger-tasks** skill
- Configure build extensions → see **trigger-config** skill
- Build AI workflows → see **trigger-agents** skill
- Add real-time UI → see **trigger-realtime** skill
