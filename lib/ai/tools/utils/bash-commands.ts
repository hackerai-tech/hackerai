const MAX_FILES_GLOB = 1000;
const MAX_GREP_LINES = 5000;

/**
 * Escape a string for safe use in bash single quotes
 */
export const escapeForBashSingleQuote = (str: string): string => {
  return str.replace(/'/g, "'\\''");
};

/**
 * Build the glob command to find files matching the pattern
 * Uses find command for POSIX compatibility (globstar requires bash 4.0+, macOS ships bash 3.2)
 */
export const buildGlobCommand = (scope: string): string => {
  const escapedScope = escapeForBashSingleQuote(scope);

  // Convert glob pattern to find command
  // Extract base directory (everything before first wildcard) and pattern
  const firstWildcardIndex = scope.search(/[*?[]/);
  if (firstWildcardIndex === -1) {
    // No wildcards - just check if the file exists
    return `test -f '${escapedScope}' && echo '${escapedScope}' || true`;
  }

  // Find the base directory (last / before first wildcard)
  const baseDir =
    scope.substring(0, firstWildcardIndex).replace(/\/[^/]*$/, "") || "/";
  const escapedBaseDir = escapeForBashSingleQuote(baseDir);

  // Convert glob pattern to find -name/-path pattern
  // Handle ** (recursive) and * (single level) patterns
  const pattern = scope.substring(baseDir.length + 1); // Remove base dir and leading /

  // Use find with -path for patterns containing /, -name otherwise
  // ** in glob means "any depth" which find handles with -path
  if (pattern.includes("/") || pattern.includes("**")) {
    // Convert ** to * for find -path (find's * matches across /)
    const findPattern = pattern.replace(/\*\*/g, "*");
    const escapedFindPattern = escapeForBashSingleQuote(findPattern);
    return `find '${escapedBaseDir}' -type f -path '*/${escapedFindPattern}' 2>/dev/null | head -n ${MAX_FILES_GLOB}`;
  } else {
    const escapedPattern = escapeForBashSingleQuote(pattern);
    return `find '${escapedBaseDir}' -type f -name '${escapedPattern}' 2>/dev/null | head -n ${MAX_FILES_GLOB}`;
  }
};

/**
 * Build the grep command to search file contents
 * Uses grep -r, skips binary files with -I
 */
export const buildGrepCommand = (
  scope: string,
  regex: string,
  leading: number,
  trailing: number,
): string => {
  const escapedRegex = escapeForBashSingleQuote(regex);

  // Build context flags
  const contextFlags = [
    leading > 0 ? `-B ${leading}` : "",
    trailing > 0 ? `-A ${trailing}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  // grep: -r recursive, -I skip binary, -H filename, -n line numbers, -E extended regex
  return `grep -r -I -H -n -E ${contextFlags} '${escapedRegex}' ${scope} 2>/dev/null | head -n ${MAX_GREP_LINES}`;
};
