type IntercomWindow = Window & {
  Intercom?: (command: string, ...args: unknown[]) => void;
};

function expireCookie(name: string, domain?: string) {
  const domainAttribute = domain ? `; domain=${domain}` : "";
  const secureAttribute =
    window.location.protocol === "https:" ? "; Secure" : "";

  document.cookie = `${name}=; Max-Age=0; path=/${domainAttribute}; SameSite=Lax${secureAttribute}`;
}

/** Clears Messenger state so another person on a shared browser cannot inherit it. */
export function shutdownIntercomSession() {
  if (typeof window === "undefined") return;

  try {
    (window as IntercomWindow).Intercom?.("shutdown");
  } catch {
    // Cookie cleanup below is the fallback when the widget is unavailable.
  }

  const intercomCookies = document.cookie
    .split(";")
    .map((cookie) => cookie.trim().split("=", 1)[0])
    .filter((name) => name.startsWith("intercom-"));

  if (intercomCookies.length === 0) return;

  const hostnameParts = window.location.hostname.split(".");
  const candidateDomains = new Set<string>();
  for (let index = 0; index < hostnameParts.length - 1; index += 1) {
    const domain = hostnameParts.slice(index).join(".");
    candidateDomains.add(domain);
    candidateDomains.add(`.${domain}`);
  }

  for (const name of intercomCookies) {
    expireCookie(name);
    for (const domain of candidateDomains) {
      expireCookie(name, domain);
    }
  }
}
