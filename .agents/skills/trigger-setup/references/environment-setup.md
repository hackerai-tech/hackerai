# Environment Setup

## Required Variables

| Variable | Description | Where to find |
|----------|-------------|---------------|
| `TRIGGER_SECRET_KEY` | API key for authentication | Dashboard > API Keys |

## Development vs Production Keys

```bash
# Development (starts with tr_dev_)
TRIGGER_SECRET_KEY=tr_dev_xxxxx

# Production (starts with tr_prod_)
TRIGGER_SECRET_KEY=tr_prod_xxxxx
```

## Local Development

### Option 1: .env File

```bash
# .env
TRIGGER_SECRET_KEY=tr_dev_xxxxx
```

Add to `.gitignore`:

```
.env
.env.local
```

### Option 2: Shell Export

```bash
export TRIGGER_SECRET_KEY=tr_dev_xxxxx
npx trigger dev
```

## CI/CD Deployment

### GitHub Actions

```yaml
- name: Deploy Trigger.dev
  env:
    TRIGGER_SECRET_KEY: ${{ secrets.TRIGGER_SECRET_KEY }}
  run: npx trigger deploy
```

### Vercel

Add `TRIGGER_SECRET_KEY` in Project Settings > Environment Variables.

### Other Platforms

Set `TRIGGER_SECRET_KEY` in your platform's secret management.

## Multi-Environment Setup

Use different keys per environment:

| Environment | Key Prefix | Dashboard Section |
|-------------|------------|-------------------|
| Development | `tr_dev_` | Dev environment |
| Staging | `tr_stg_` | Staging environment |
| Production | `tr_prod_` | Prod environment |

## Task Environment Variables

Tasks run in Trigger.dev's infrastructure. To use env vars in tasks:

1. **Sync from local** (using `syncEnvVars` extension):

```ts
// trigger.config.ts
import { defineConfig } from "@trigger.dev/sdk";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  project: "proj_xxxxx",
  build: {
    extensions: [
      syncEnvVars(),
    ],
  },
});
```

2. **Set in dashboard**: Project Settings > Environment Variables

3. **Access in tasks**:

```ts
export const myTask = task({
  id: "my-task",
  run: async () => {
    const apiKey = process.env.EXTERNAL_API_KEY;
    // ...
  },
});
```
