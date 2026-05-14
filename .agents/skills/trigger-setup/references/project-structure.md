# Project Structure

## Default Layout

```
your-project/
├── trigger.config.ts    # Required - project configuration
├── trigger/             # Default task directory
│   ├── example.ts       # Created by `npx trigger init`
│   └── ...
├── package.json
└── src/                 # Your app code
```

## Monorepo Layout

For monorepos, place `trigger.config.ts` in the package that contains your tasks:

```
monorepo/
├── packages/
│   ├── api/
│   │   ├── trigger.config.ts  # Config here
│   │   ├── trigger/           # Tasks here
│   │   └── src/
│   └── web/
└── package.json
```

## Multiple Task Directories

Configure multiple directories in `trigger.config.ts`:

```ts
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_xxxxx",
  dirs: [
    "./trigger",           // Default
    "./src/jobs",          // Additional
    "./src/scheduled",     // Another
  ],
});
```

## Collocated Tasks

Keep tasks next to related code:

```
src/
├── users/
│   ├── routes.ts
│   └── tasks/
│       └── send-welcome-email.ts
├── orders/
│   ├── routes.ts
│   └── tasks/
│       └── process-order.ts
```

```ts
// trigger.config.ts
export default defineConfig({
  project: "proj_xxxxx",
  dirs: ["./src/**/tasks"],  // Glob pattern
});
```

## Task File Requirements

Each task file must:

1. **Export** tasks (named exports)
2. Use `task()` or `schemaTask()` from `@trigger.dev/sdk`
3. Have unique task IDs across all files

```ts
// ✅ Correct - exported task
export const myTask = task({
  id: "my-task",  // Unique ID
  run: async (payload) => { ... },
});

// ❌ Wrong - not exported
const privateTask = task({ ... });

// ❌ Wrong - duplicate ID will error
export const anotherTask = task({
  id: "my-task",  // Conflicts!
  run: async (payload) => { ... },
});
```
