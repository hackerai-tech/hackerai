/**
 * OrcaRouter uses two public origins: account authorization lives on the
 * website origin (`/auth`, `/api/v1/auth/keys`) while inference and the model
 * catalog live on the API origin (`/v1`). Never derive one public origin from
 * the other; self-hosted gateways may use one shared origin or explicit
 * per-surface overrides, and explicit overrides win.
 */
export const ORCAROUTER_DEFAULT_AUTH_ORIGIN = "https://www.orcarouter.ai";
export const ORCAROUTER_DEFAULT_API_BASE_URL = "https://api.orcarouter.ai/v1";
export const ORCAROUTER_KEYS_URL = "https://www.orcarouter.ai/console";
export const ORCAROUTER_AUTHORIZED_APPS_URL =
  "https://www.orcarouter.ai/console/authorized-apps";

export type OrcaRouterEndpoints = {
  /** Origin that serves the consent screen and the code exchange. */
  authOrigin: string;
  /** OpenAI-compatible inference base URL, including its `/v1` path. */
  apiBaseUrl: string;
};

type Env = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const trimmed = (value: string | undefined) => {
  const next = value?.trim();
  return next ? next : undefined;
};

/**
 * Accept HTTPS everywhere and plain HTTP only for loopback development
 * gateways, so a misconfigured value cannot send credentials in cleartext.
 */
export function parseOrcaRouterUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`${name} must not include credentials or a fragment`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${name} must use https (http is allowed for loopback)`);
  }
  return url;
}

const withoutTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export function resolveOrcaRouterEndpoints(
  env: Env = process.env,
): OrcaRouterEndpoints {
  const shared = trimmed(env.ORCAROUTER_BASE_URL);
  const authOverride = trimmed(env.ORCAROUTER_AUTH_BASE_URL);
  const apiOverride = trimmed(env.ORCAROUTER_API_BASE_URL);

  const sharedOrigin = shared
    ? parseOrcaRouterUrl(shared, "ORCAROUTER_BASE_URL").origin
    : undefined;

  const authOrigin = authOverride
    ? parseOrcaRouterUrl(authOverride, "ORCAROUTER_AUTH_BASE_URL").origin
    : (sharedOrigin ?? ORCAROUTER_DEFAULT_AUTH_ORIGIN);

  // A shared self-hosted origin serves the relay at its documented `/v1`
  // path. An explicit API override is used verbatim as the full base URL.
  const apiBaseUrl = apiOverride
    ? withoutTrailingSlash(
        parseOrcaRouterUrl(apiOverride, "ORCAROUTER_API_BASE_URL").toString(),
      )
    : sharedOrigin
      ? `${sharedOrigin}/v1`
      : ORCAROUTER_DEFAULT_API_BASE_URL;

  return { authOrigin, apiBaseUrl };
}
