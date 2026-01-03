/**
 * Guardrails System - Security policies for blocking dangerous commands.
 *
 * This module provides security policies for detecting and blocking
 * dangerous terminal commands that could harm the system.
 */

// =============================================================================
// TYPES AND ENUMS
// =============================================================================

export enum GuardrailAction {
  BLOCK = "block", // Stop execution, return error
  WARN = "warn", // Log warning, continue execution
  LOG = "log", // Log only, no action
}

export enum Severity {
  CRITICAL = "critical",
  HIGH = "high",
  MEDIUM = "medium",
  LOW = "low",
  INFO = "info",
}

export interface GuardrailResult {
  allowed: boolean;
  policyName?: string;
  actionTaken?: GuardrailAction;
  severity?: Severity;
  message?: string;
  matchedPattern?: string;
  detectedPatterns: string[];
}

// =============================================================================
// DEFAULT GUARDRAILS - Dangerous Command Patterns
// =============================================================================

export interface GuardrailConfig {
  id: string;
  name: string;
  description: string;
  category: "dangerous_commands";
  enabled: boolean;
  severity: Severity;
  patterns: string[];
}

// UI-friendly version (without patterns array, severity as string)
export interface GuardrailConfigUI {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  severity: "critical" | "high" | "medium" | "low";
}

// Convert GuardrailConfig to UI format
export const toGuardrailConfigUI = (
  config: GuardrailConfig,
): GuardrailConfigUI => ({
  id: config.id,
  name: config.name,
  description: config.description,
  enabled: config.enabled,
  severity: config.severity as "critical" | "high" | "medium" | "low",
});

// Convert UI format back to GuardrailConfig
export const fromGuardrailConfigUI = (
  config: GuardrailConfigUI,
  original: GuardrailConfig,
): GuardrailConfig => ({
  ...original,
  enabled: config.enabled,
});

export const DEFAULT_GUARDRAILS: GuardrailConfig[] = [
  {
    id: "block_rm_rf",
    name: "Block recursive delete on root",
    description: "Blocks 'rm -rf /' and similar destructive commands",
    category: "dangerous_commands",
    enabled: true,
    severity: Severity.CRITICAL,
    patterns: ["rm\\s+(?:-rf?|--recursive)\\s+/"],
  },
  {
    id: "block_fork_bomb",
    name: "Block fork bombs",
    description: "Blocks bash fork bomb patterns that can crash systems",
    category: "dangerous_commands",
    enabled: true,
    severity: Severity.CRITICAL,
    patterns: [":\\(\\)\\s*{\\s*:\\|:\\s*&\\s*}\\s*;:"],
  },
  {
    id: "block_disk_wipe",
    name: "Block disk wipe commands",
    description: "Blocks dd commands that write zeros/random to disks",
    category: "dangerous_commands",
    enabled: true,
    severity: Severity.CRITICAL,
    patterns: ["dd\\s+if=/dev/(?:zero|random|urandom)\\s+of=/dev/[hs]d[a-z]"],
  },
  {
    id: "block_mkfs",
    name: "Block filesystem format",
    description: "Blocks mkfs commands that format filesystems",
    category: "dangerous_commands",
    enabled: true,
    severity: Severity.CRITICAL,
    patterns: ["mkfs\\.?\\w*\\s+/dev/"],
  },
  {
    id: "block_curl_pipe_shell",
    name: "Block curl pipe to shell",
    description: "Blocks curl | bash patterns for remote code execution",
    category: "dangerous_commands",
    enabled: true,
    severity: Severity.CRITICAL,
    patterns: ["curl.*\\|\\s*(?:bash|sh|python|perl|ruby|php)"],
  },
  {
    id: "block_wget_pipe_shell",
    name: "Block wget pipe to shell",
    description: "Blocks wget | bash patterns for remote code execution",
    category: "dangerous_commands",
    enabled: true,
    severity: Severity.CRITICAL,
    patterns: ["wget.*\\|\\s*(?:bash|sh|python|perl|ruby|php)"],
  },
  {
    id: "block_reverse_shells",
    name: "Block reverse shell patterns",
    description:
      "Blocks common reverse shell patterns (bash, nc, python, socat)",
    category: "dangerous_commands",
    enabled: true,
    severity: Severity.CRITICAL,
    patterns: [
      "(?:bash|sh)\\s+-i\\s+>&\\s*/dev/tcp/",
      "(?:nc|netcat)\\s+.*-e\\s+(?:/bin/(?:ba)?sh|cmd)",
      "python[23]?\\s+-c\\s+['\"].*(?:socket|subprocess|pty).*(?:connect|spawn)",
      "socat\\s+(?:TCP|UDP):\\d+\\.\\d+\\.\\d+\\.\\d+:\\d+.*EXEC",
      "mkfifo\\s+.*(?:nc|netcat|cat)",
    ],
  },
  {
    id: "block_env_exfil",
    name: "Block environment exfiltration",
    description: "Blocks curl/wget with $(env) or `env` for credential theft",
    category: "dangerous_commands",
    enabled: true,
    severity: Severity.CRITICAL,
    patterns: [
      "curl.*\\$\\(env\\)|curl.*`env`",
      "wget.*\\$\\(env\\)|wget.*`env`",
    ],
  },
  {
    id: "block_sudoers_edit",
    name: "Block sudoers modification",
    description: "Blocks attempts to modify /etc/sudoers",
    category: "dangerous_commands",
    enabled: true,
    severity: Severity.CRITICAL,
    patterns: ["(?:vi|vim|nano|echo.*>>?)\\s+/etc/sudoers"],
  },
];

// =============================================================================
// GUARDRAIL ENGINE
// =============================================================================

/**
 * Parse user guardrail configuration.
 * Format: "id:enabled" per line (e.g., "block_rm_rf:true\nblock_fork_bomb:false")
 */
export const parseGuardrailConfig = (
  config: string | undefined,
): Map<string, boolean> => {
  const result = new Map<string, boolean>();

  if (!config || config.trim() === "") {
    return result;
  }

  const lines = config.split(/[\n,]/).filter((line) => line.trim());

  for (const line of lines) {
    const [id, enabledStr] = line.split(":").map((s) => s.trim());
    if (id && enabledStr !== undefined) {
      result.set(id, enabledStr.toLowerCase() === "true");
    }
  }

  return result;
};

/**
 * Get effective guardrails based on user configuration.
 */
export const getEffectiveGuardrails = (
  userConfig: Map<string, boolean>,
): GuardrailConfig[] => {
  return DEFAULT_GUARDRAILS.map((guardrail) => {
    const userEnabled = userConfig.get(guardrail.id);
    return {
      ...guardrail,
      enabled: userEnabled !== undefined ? userEnabled : guardrail.enabled,
    };
  });
};

/**
 * Check a command against guardrails (dangerous command patterns only).
 */
export const checkCommandGuardrails = (
  command: string,
  guardrails: GuardrailConfig[],
): GuardrailResult => {
  const detectedPatterns: string[] = [];

  // Check against enabled guardrails
  for (const guardrail of guardrails) {
    if (!guardrail.enabled) continue;

    for (const patternStr of guardrail.patterns) {
      try {
        const pattern = new RegExp(patternStr, "i");
        if (pattern.test(command)) {
          // For CRITICAL severity, block immediately
          if (guardrail.severity === Severity.CRITICAL) {
            return {
              allowed: false,
              policyName: guardrail.id,
              actionTaken: GuardrailAction.BLOCK,
              severity: guardrail.severity,
              message: guardrail.description,
              matchedPattern: patternStr,
              detectedPatterns: [guardrail.id],
            };
          }

          // For other severities, collect patterns
          detectedPatterns.push(guardrail.id);
        }
      } catch {
        // Invalid regex pattern, skip
      }
    }
  }

  // If we have warning-level patterns, return with warning but allow
  if (detectedPatterns.length > 0) {
    return {
      allowed: true,
      actionTaken: GuardrailAction.WARN,
      severity: Severity.MEDIUM,
      message: `Detected patterns: ${detectedPatterns.join(", ")}`,
      detectedPatterns,
    };
  }

  return {
    allowed: true,
    detectedPatterns: [],
  };
};

/**
 * Format guardrails for display in UI.
 */
export const formatGuardrailsForDisplay = (
  guardrails: GuardrailConfig[],
): string => {
  return guardrails.map((g) => `${g.id}:${g.enabled}`).join("\n");
};

/**
 * Get default guardrails in UI format.
 */
export const getDefaultGuardrailsUI = (): GuardrailConfigUI[] => {
  return DEFAULT_GUARDRAILS.map(toGuardrailConfigUI);
};

/**
 * Parse guardrails config from string format "id:enabled" per line
 * and merge with default guardrails.
 */
export const parseAndMergeGuardrailsConfig = (
  config: string | undefined,
): GuardrailConfigUI[] => {
  const userConfig = parseGuardrailConfig(config);
  return DEFAULT_GUARDRAILS.map((guardrail) => {
    const userEnabled = userConfig.get(guardrail.id);
    return toGuardrailConfigUI({
      ...guardrail,
      enabled: userEnabled !== undefined ? userEnabled : guardrail.enabled,
    });
  });
};

/**
 * Format guardrails config to string format for saving.
 */
export const formatGuardrailsConfigForSave = (
  guardrails: GuardrailConfigUI[],
): string => {
  return guardrails.map((g) => `${g.id}:${g.enabled}`).join("\n");
};

/**
 * Check if guardrails have changed from defaults or saved config.
 */
export const hasGuardrailChanges = (
  guardrails: GuardrailConfigUI[],
  savedConfig: string | undefined,
): boolean => {
  const currentConfig = formatGuardrailsConfigForSave(guardrails);
  const saved = savedConfig || "";

  if (saved === "") {
    // Check if any guardrail differs from defaults
    return guardrails.some((g) => {
      const defaultGuardrail = DEFAULT_GUARDRAILS.find((dg) => dg.id === g.id);
      return defaultGuardrail && g.enabled !== defaultGuardrail.enabled;
    });
  }

  // Compare with saved config
  const currentMap = parseGuardrailConfig(currentConfig);
  const savedMap = parseGuardrailConfig(saved);
  for (const [id, enabled] of currentMap) {
    if (savedMap.get(id) !== enabled) {
      return true;
    }
  }
  return false;
};
