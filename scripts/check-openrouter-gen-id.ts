#!/usr/bin/env tsx

/**
 * Inspect what OpenRouter actually returns so we can verify whether
 * extractRetryAttempts captures a `gen-…` ID rather than a Cloudflare ray.
 *
 * Usage:
 *   npx tsx scripts/check-openrouter-gen-id.ts
 *
 * Two probes:
 *   1. Successful call against a cheap model — shows what response headers
 *      and body fields OpenRouter exposes (so we know where the gen-id
 *      actually lives in practice).
 *   2. Invalid-slug call to provoke a 4xx — shows the error path that
 *      extractRetryAttempts walks.
 */

import { config } from "dotenv";
import { resolve } from "path";
import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { openrouterAttributionHeaders } from "../lib/ai/openrouter-attribution";

config({ path: resolve(process.cwd(), ".env.local") });

import { extractRetryAttempts } from "../lib/utils/error-utils";

const VALID_SLUG = "moonshotai/kimi-k2.7-code:exacto";
const INVALID_SLUG = "anthropic/this-model-does-not-exist-please-fail";

function classify(id: string | undefined): string {
  if (!id) return "(none)";
  if (id.startsWith("gen-"))
    return `${id}  ✅ gen-id (queryable in OpenRouter activity dashboard)`;
  if (id.startsWith("req-")) return `${id}  ✅ req-id (OpenRouter request id)`;
  if (/-[A-Z]{3}$/.test(id))
    return `${id}  ⚠️  Cloudflare ray (extraction fell back to headers)`;
  return `${id}  ❓ unknown format`;
}

async function probeSuccess(openrouter: ReturnType<typeof createOpenRouter>) {
  console.log("\n" + "═".repeat(70));
  console.log("PROBE 1 — successful call (looking for where the gen-id lives)");
  console.log("═".repeat(70));

  // Use a passthrough fetch so we can inspect raw response headers/body.
  let capturedHeaders: Record<string, string> = {};
  let capturedBodyPreview = "";
  const probeFetch: typeof fetch = async (url, init) => {
    const res = await globalThis.fetch(url, init);
    const clone = res.clone();
    capturedHeaders = Object.fromEntries(clone.headers.entries());
    try {
      const text = await clone.text();
      capturedBodyPreview = text.slice(0, 400);
    } catch {
      // ignore
    }
    return res;
  };

  const or = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY!,
    fetch: probeFetch,
    headers: openrouterAttributionHeaders,
  });

  try {
    const res = await generateText({
      model: or(VALID_SLUG),
      messages: [{ role: "user", content: "say 'ok'" }],
      maxRetries: 0,
    });

    console.log(`\nresponse.modelId: ${res.response.modelId}`);
    console.log("\nresponse headers (gen-id-relevant):");
    const idHeaders = [
      "x-generation-id",
      "x-request-id",
      "request-id",
      "cf-ray",
      "access-control-expose-headers",
    ];
    for (const h of idHeaders) {
      const v = capturedHeaders[h];
      if (v) console.log(`  ${h}: ${v}`);
    }

    console.log("\nresponse body (preview):");
    try {
      const parsed = JSON.parse(
        capturedBodyPreview + (capturedBodyPreview.endsWith("}") ? "" : "}"),
      );
      console.log(`  id (gen-…?): ${parsed.id ?? "(missing)"}`);
      console.log(`  model: ${parsed.model ?? "(missing)"}`);
    } catch {
      console.log(`  ${capturedBodyPreview}`);
    }
  } catch (err) {
    console.error("Successful probe failed:", (err as Error).message);
  }
}

async function probeError(openrouter: ReturnType<typeof createOpenRouter>) {
  console.log("\n" + "═".repeat(70));
  console.log("PROBE 2 — invalid-slug call (verifies extractRetryAttempts)");
  console.log("═".repeat(70));

  let caught: unknown;
  try {
    await generateText({
      model: openrouter(INVALID_SLUG),
      messages: [{ role: "user", content: "hello" }],
      maxRetries: 1, // forces an AI_RetryError wrapper
    });
  } catch (err) {
    caught = err;
  }

  if (!caught) {
    console.log("(no error thrown — slug was accepted?)");
    return;
  }

  const e = caught as Record<string, unknown>;
  const inner = (e as { errors?: unknown[] }).errors?.[0] as
    | Record<string, unknown>
    | undefined;

  console.log(`\nouter error: ${(caught as Error).name}`);
  console.log(
    `has errors[] array: ${Array.isArray((e as { errors?: unknown }).errors)}`,
  );

  if (inner) {
    console.log(`\ninner attempt fields used by extractRequestId:`);
    console.log(`  statusCode: ${inner.statusCode}`);
    const data = inner.data as
      | { id?: unknown; request_id?: unknown }
      | undefined;
    console.log(`  data.id: ${data?.id ?? "(missing)"}`);
    console.log(`  data.request_id: ${data?.request_id ?? "(missing)"}`);
    console.log(
      `  responseBody (first 200 chars): ${
        typeof inner.responseBody === "string"
          ? inner.responseBody.slice(0, 200)
          : "(not a string)"
      }`,
    );
    const headers = inner.responseHeaders as Record<string, string> | undefined;
    if (headers) {
      console.log(
        `  responseHeaders.x-generation-id: ${headers["x-generation-id"] ?? "(missing)"}`,
      );
      console.log(
        `  responseHeaders.cf-ray: ${headers["cf-ray"] ?? "(missing)"}`,
      );
    }
  }

  console.log(`\nextractRetryAttempts result:`);
  const attempts = extractRetryAttempts(caught);
  if (!attempts) {
    console.log("  (no attempts array — error wasn't wrapped in RetryError)");
  } else {
    for (const [i, a] of attempts.entries()) {
      console.log(`  attempt[${i}].request_id: ${classify(a.request_id)}`);
    }
  }
}

async function probeSimulated5xx() {
  console.log("\n" + "═".repeat(70));
  console.log("PROBE 3 — simulated 5xx shape (mirrors production error logs)");
  console.log("═".repeat(70));
  console.log(
    "\nProduction 5xx errors come back wrapped in AI_RetryError with each",
  );
  console.log(
    "attempt's body lacking `id` (no JSON envelope) but `X-Generation-Id`",
  );
  console.log("present as a CORS-exposed header. Mirroring that shape:");

  const inner = Object.assign(new Error("Internal Server Error"), {
    name: "AI_APICallError",
    statusCode: 500,
    responseBody: "Internal Server Error",
    responseHeaders: {
      "x-generation-id": "gen-1778099999-SimulatedFailureId",
      "cf-ray": "9f72c2a5a959778a-IAD",
      "access-control-expose-headers": "X-Generation-Id,cf-ray",
    },
  });
  const retry = Object.assign(new Error("Failed after 3 attempts."), {
    name: "AI_RetryError",
    errors: [inner, inner, inner],
  });

  const attempts = extractRetryAttempts(retry);
  if (!attempts) {
    console.log("\n❌ extractRetryAttempts returned nothing — bug in fix");
    return;
  }
  console.log("\nextractRetryAttempts captured:");
  for (const [i, a] of attempts.entries()) {
    console.log(`  attempt[${i}].request_id: ${classify(a.request_id)}`);
  }
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("❌ OPENROUTER_API_KEY not set in .env.local");
    process.exit(1);
  }
  const openrouter = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
    headers: openrouterAttributionHeaders,
  });
  await probeSuccess(openrouter);
  await probeError(openrouter);
  await probeSimulated5xx();
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
