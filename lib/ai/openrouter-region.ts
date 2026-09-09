const GLOBAL_ORIGIN = "https://openrouter.ai";
const EU_ORIGIN = "https://eu.openrouter.ai";
const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_FAILURE_TTL_MS = 30_000;

export type OpenRouterRegionOutcome = "eu" | "global_no_eu_endpoint";

export type OpenRouterRegionOptions = {
  preferEurope?: boolean;
  onRoute?: (outcome: OpenRouterRegionOutcome) => void;
};

/** Uses trusted ingress geography; absent location keeps the global default. */
export function isEuropeanRequest(request: { headers: Headers }): boolean {
  return (
    request.headers.get("x-vercel-ip-continent")?.trim().toUpperCase() === "EU"
  );
}

/** Shares bounded public catalog lookups without sending auth or prompts. */
export function createEuModelCatalog(
  fetchCatalog: typeof fetch = (...args) => globalThis.fetch(...args),
): () => Promise<Set<string> | null> {
  let cached: Set<string> | null = null;
  let expiresAt = 0;
  let pending: Promise<Set<string> | null> | undefined;

  return async () => {
    if (Date.now() < expiresAt) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetchCatalog(
          `${GLOBAL_ORIGIN}/api/v1/models?region=eu`,
          {
            signal: AbortSignal.timeout(2_000),
          },
        );
        if (!response.ok) throw new Error("EU model catalog unavailable");
        const body = await response.json();
        if (
          !Array.isArray(body?.data) ||
          !body.data.every(
            (model: unknown) =>
              typeof model === "object" &&
              model !== null &&
              "id" in model &&
              typeof model.id === "string",
          )
        )
          throw new Error("Invalid EU model catalog");
        cached = new Set(body.data.map((model: { id: string }) => model.id));
        expiresAt = Date.now() + CATALOG_TTL_MS;
      } catch {
        cached = null;
        expiresAt = Date.now() + CATALOG_FAILURE_TTL_MS;
      }
      return cached;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}

const getEuModels = createEuModelCatalog();

/** Prefers EU for eligible models, replaying only pre-stream availability errors. */
export function createOpenRouterRegionFetch(
  fetchInference: typeof fetch,
  options: OpenRouterRegionOptions,
  loadEuModels = getEuModels,
): typeof fetch {
  return async (input, init) => {
    // The SDK sends replayable JSON strings. Leave other fetch surfaces alone.
    if (
      !options.preferEurope ||
      input instanceof Request ||
      init?.method?.toUpperCase() !== "POST" ||
      typeof init.body !== "string"
    ) {
      return fetchInference(input, init);
    }
    const url = new URL(input);
    if (
      url.origin !== GLOBAL_ORIGIN ||
      url.pathname !== "/api/v1/chat/completions"
    ) {
      return fetchInference(input, init);
    }
    let model: unknown;
    try {
      model = JSON.parse(init.body)?.model;
    } catch {
      return fetchInference(input, init);
    }
    init.signal?.throwIfAborted();
    const models = typeof model === "string" ? await loadEuModels() : null;
    init.signal?.throwIfAborted();
    if (!models || typeof model !== "string" || !models.has(model)) {
      return fetchInference(input, init);
    }

    const recordRoute = (outcome: OpenRouterRegionOutcome) => {
      try {
        options.onRoute?.(outcome);
      } catch {
        /* Analytics must not affect inference. */
      }
    };
    const euUrl = new URL(url);
    euUrl.hostname = new URL(EU_ORIGIN).hostname;
    recordRoute("eu");
    const response = await fetchInference(euUrl, init);
    // Only replay pre-stream endpoint-availability failures. Successful streams,
    // auth/guardrail errors, billing errors, and cancellations are never replayed.
    if (response.status !== 404 && response.status !== 503) return response;
    if (response.status === 404) {
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      if (
        typeof body?.error?.message !== "string" ||
        !/^no (?:(?:available )?(?:endpoints|providers)\b|allowed providers are available\b)/i.test(
          body.error.message,
        )
      )
        return response;
    }
    await response.body?.cancel();
    init.signal?.throwIfAborted();
    recordRoute("global_no_eu_endpoint");
    return fetchInference(input, init);
  };
}
