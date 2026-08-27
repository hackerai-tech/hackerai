# agent-sandbox - E2B Sandbox Template

This is an E2B sandbox template that allows you to run code in a controlled environment.

## Prerequisites

Before you begin, make sure you have:

- An E2B account (sign up at [e2b.dev](https://e2b.dev))
- Your E2B API key (get it from your [E2B dashboard](https://e2b.dev/dashboard))
- Node.js and npm/yarn (or similar) installed

## Configuration

1. Add your E2B API key to `.env.local` in the project root:
   ```
   E2B_API_KEY=your_api_key_here
   ```

For the separate EU cluster, add its server-side credentials without replacing
the US key:

```dotenv
E2B_EU_API_KEY=your_eu_api_key_here
E2B_EU_DOMAIN=e2b-juliett.dev
```

## Building the Template

```bash
# For development
pnpm run e2b:build:dev

# For production
pnpm run e2b:build:prod

# For the EU development template
pnpm run e2b:build:eu:dev

# For the EU production template
pnpm run e2b:build:eu:prod
```

The EU commands pass the separate key and `e2b-juliett.dev` domain directly to
the E2B SDK. They do not overwrite or reuse `E2B_API_KEY`. Set
`E2B_EU_TEMPLATE` only when the EU template alias should differ from
`terminal-agent-sandbox-dev` or `terminal-agent-sandbox`.

## Using the Template in a Sandbox

Once your template is built, you can use it in your E2B sandbox:

```typescript
import { Sandbox } from "e2b";

// Create a new sandbox instance
const sandbox = await Sandbox.create("agent-sandbox");

// Your sandbox is ready to use!
console.log("Sandbox created successfully");
```

## Template Structure

- `template.ts` - Defines the sandbox template configuration
- `build.dev.ts` - Builds the template for development
- `build.prod.ts` - Builds the template for production

## Next Steps

1. Customize the template in `template.ts` to fit your needs
2. Build the template using one of the methods above
3. Use the template in your E2B sandbox code
4. Check out the [E2B documentation](https://e2b.dev/docs) for more advanced usage
