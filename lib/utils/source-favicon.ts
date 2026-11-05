const INTERNAL_LABELS = new Set(["corp", "internal", "intranet"]);
const PRIVATE_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "home.arpa",
  "ts.net",
  "alt",
  "corp",
  "example",
  "home",
  "internal",
  "intranet",
  "invalid",
  "lan",
  "onion",
  "private",
  "test",
];

/**
 * Only disclose a syntactically valid, public-looking DNS hostname to the icon
 * service. This is a disclosure filter, not proof of public DNS resolution or
 * non-sensitive content. IP literals and single-label hosts use local icons.
 */
export function sourceFaviconUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // URL normalizes IDNs and numeric IPv4 forms before classification.
    const host = url.hostname.replace(/\.$/, "");
    if (host.length > 253 || host.includes(":") || /^[\d.]+$/.test(host)) {
      return null;
    }
    const labels = host.split(".");
    if (
      labels.length < 2 ||
      labels.some(
        (label) =>
          !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ||
          INTERNAL_LABELS.has(label),
      ) ||
      PRIVATE_SUFFIXES.some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`),
      )
    ) {
      return null;
    }
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  } catch {
    return null;
  }
}
