import { ConvexHttpClient } from "convex/browser";

// Shared singleton so Trigger.dev's setConvexUrl() override reaches every
// caller. Lazy-init the client so this module is safe to import from code
// paths that Convex's deploy bundler analyzes (e.g.
// convex/rateLimitStatus → lib/rate-limit/token-bucket → lib/extra-usage);
// constructing ConvexHttpClient eagerly with the empty URL the analyzer
// sees would fail validation and break `convex deploy`.

let client: ConvexHttpClient | null = null;
let overrideUrl: string | undefined;

export function getConvexClient(): ConvexHttpClient {
  if (!client) {
    const url = overrideUrl ?? process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) {
      throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
    }
    client = new ConvexHttpClient(url);
  }
  return client;
}

// Called by Trigger.dev tasks to point at the correct per-branch preview
// deployment. The Trigger.dev process's NEXT_PUBLIC_CONVEX_URL only reflects
// what the dashboard has configured, so the route forwards the right URL via
// the task payload and the task calls this. Each Trigger.dev run is an
// isolated worker process so mutation is safe.
export function setConvexUrl(url: string) {
  overrideUrl = url;
  client = new ConvexHttpClient(url);
}
