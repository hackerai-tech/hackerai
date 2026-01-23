/**
 * Utility functions for checking scope exclusions.
 * Prevents tools from targeting excluded domains, IPs, and networks.
 */

/**
 * Parse scope exclusions string into an array of exclusion patterns.
 * Supports newline-separated or comma-separated lists.
 */
export const parseScopeExclusions = (exclusions: string): string[] => {
  if (!exclusions || exclusions.trim() === "") {
    return [];
  }

  return exclusions
    .split(/[\n,]/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
};

/**
 * Check if a hostname matches a wildcard pattern.
 * E.g., "*.example.com" matches "sub.example.com" and "a.b.example.com"
 */
const matchesWildcard = (hostname: string, pattern: string): boolean => {
  if (!pattern.startsWith("*.")) {
    return false;
  }

  const suffix = pattern.slice(2); // Remove "*."
  // Match the exact domain or any subdomain
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
};

/**
 * Check if an IP address falls within a CIDR range.
 * Supports IPv4 only for now.
 */
const ipInCidr = (ip: string, cidr: string): boolean => {
  const [range, bits] = cidr.split("/");
  if (!bits) return ip === cidr;

  const mask = parseInt(bits, 10);
  if (isNaN(mask) || mask < 0 || mask > 32) return false;

  const ipParts = ip.split(".").map(Number);
  const rangeParts = range.split(".").map(Number);

  if (ipParts.length !== 4 || rangeParts.length !== 4) return false;
  if (ipParts.some((p) => isNaN(p) || p < 0 || p > 255)) return false;
  if (rangeParts.some((p) => isNaN(p) || p < 0 || p > 255)) return false;

  const ipNum =
    (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
  const rangeNum =
    (rangeParts[0] << 24) |
    (rangeParts[1] << 16) |
    (rangeParts[2] << 8) |
    rangeParts[3];

  const maskNum = mask === 0 ? 0 : ~((1 << (32 - mask)) - 1);

  return (ipNum & maskNum) === (rangeNum & maskNum);
};

/**
 * Check if a given IP address is in IPv4 format.
 */
const isIPv4 = (str: string): boolean => {
  const parts = str.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const num = parseInt(p, 10);
    return !isNaN(num) && num >= 0 && num <= 255 && p === String(num);
  });
};

/**
 * Check if a target (hostname or IP) matches any scope exclusion.
 * Returns the matched exclusion pattern if found, null otherwise.
 */
export const checkScopeExclusion = (
  target: string,
  exclusions: string[],
): string | null => {
  if (exclusions.length === 0) {
    return null;
  }

  const normalizedTarget = target.toLowerCase().trim();

  for (const exclusion of exclusions) {
    // Direct match
    if (normalizedTarget === exclusion) {
      return exclusion;
    }

    // Wildcard match (e.g., *.example.com)
    if (exclusion.startsWith("*.")) {
      if (matchesWildcard(normalizedTarget, exclusion)) {
        return exclusion;
      }
    }

    // CIDR match for IPs
    if (exclusion.includes("/") && isIPv4(normalizedTarget)) {
      if (ipInCidr(normalizedTarget, exclusion)) {
        return exclusion;
      }
    }
  }

  return null;
};

/**
 * Extract hostname/IP from a URL.
 */
export const extractHostFromUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Extract potential targets from a command string.
 * Looks for URLs, IPs, and hostnames in common command patterns.
 */
export const extractTargetsFromCommand = (command: string): string[] => {
  const targets: string[] = [];

  // Extract URLs
  const urlRegex = /https?:\/\/([^\s/:]+)/gi;
  let match;
  while ((match = urlRegex.exec(command)) !== null) {
    targets.push(match[1].toLowerCase());
  }

  // Extract IPs (basic IPv4 pattern)
  const ipRegex = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
  while ((match = ipRegex.exec(command)) !== null) {
    if (isIPv4(match[1])) {
      targets.push(match[1]);
    }
  }

  // Common pentesting tool patterns with targets
  const toolPatterns = [
    // nmap target
    /nmap\s+(?:-[^\s]+\s+)*([^\s-][^\s]*)/i,
    // curl/wget URL
    /(?:curl|wget)\s+(?:-[^\s]+\s+)*['"]?(https?:\/\/[^\s'"]+)/i,
    // ping/host/dig target
    /(?:ping|host|dig|nslookup)\s+(?:-[^\s]+\s+)*([^\s-][^\s]*)/i,
    // sqlmap target
    /sqlmap\s+(?:-[^\s]+\s+)*-u\s+['"]?(https?:\/\/[^\s'"]+)/i,
    // nikto target
    /nikto\s+(?:-[^\s]+\s+)*-h\s+['"]?([^\s'"]+)/i,
    // gobuster/ffuf/dirsearch target
    /(?:gobuster|ffuf|dirsearch)\s+(?:[^\s]+\s+)*-u\s+['"]?(https?:\/\/[^\s'"]+)/i,
    // nuclei target
    /nuclei\s+(?:-[^\s]+\s+)*-u\s+['"]?(https?:\/\/[^\s'"]+)/i,
    // nc/netcat target
    /(?:nc|netcat)\s+(?:-[^\s]+\s+)*([^\s-][^\s]+)\s+\d+/i,
    // ssh target
    /ssh\s+(?:-[^\s]+\s+)*(?:[^\s@]+@)?([^\s:]+)/i,
  ];

  for (const pattern of toolPatterns) {
    const toolMatch = command.match(pattern);
    if (toolMatch && toolMatch[1]) {
      let extracted = toolMatch[1];

      // Clean up the extracted target
      extracted = extracted.replace(/['"]/g, "").toLowerCase();

      // If it looks like a URL, extract the host
      if (extracted.startsWith("http")) {
        const host = extractHostFromUrl(extracted);
        if (host) {
          targets.push(host);
        }
      } else {
        // Remove trailing slashes or paths
        const cleaned = extracted.split("/")[0].split(":")[0];
        if (cleaned && !cleaned.startsWith("-")) {
          targets.push(cleaned);
        }
      }
    }
  }

  // Return unique targets
  return [...new Set(targets)];
};

/**
 * Check if a command targets any excluded scope.
 * Returns an object with match info if found, null otherwise.
 */
export const checkCommandScopeExclusion = (
  command: string,
  exclusions: string[],
): { target: string; exclusion: string } | null => {
  if (exclusions.length === 0) {
    return null;
  }

  const targets = extractTargetsFromCommand(command);

  for (const target of targets) {
    const matched = checkScopeExclusion(target, exclusions);
    if (matched) {
      return { target, exclusion: matched };
    }
  }

  return null;
};
