/** Claude provider settings and Claude Code compatibility types. */

// Re-export shared defaults for backward compatibility within the Claude package
export { DEFAULT_CLAUDIAN_SETTINGS as DEFAULT_SETTINGS } from '../../../core/bootstrap/defaultSettings';

/**
 * Platform-specific Claude CLI paths.
 * @deprecated Use HostnameCliPaths instead. Kept for migration from older versions.
 */
export interface PlatformCliPaths {
  macos: string;
  linux: string;
  windows: string;
}

/** Platform key for CLI paths. Used for migration only. */
export type CliPlatformKey = keyof PlatformCliPaths;

/**
 * Map process.platform to CLI platform key.
 * @deprecated Used for migration only.
 */
export function getCliPlatformKey(): CliPlatformKey {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return 'linux';
  }
}

/**
 * Legacy permission format (pre-CC compatibility).
 * @deprecated Use CCPermissions instead
 */
export interface LegacyPermission {
  toolName: string;
  pattern: string;
  approvedAt: number;
  scope: 'session' | 'always';
}

/**
 * CC-compatible permission rule string.
 * Format: "Tool(pattern)" or "Tool" for all
 * Examples: "Bash(git *)", "Read(*.md)", "WebFetch(domain:github.com)"
 */
export type PermissionRule = string & { readonly __brand: 'PermissionRule' };

/**
 * Create a PermissionRule from a string.
 * @internal Use legacyPermissionToCCRule instead.
 */
export function createPermissionRule(rule: string): PermissionRule {
  return rule as PermissionRule;
}

/**
 * CC-compatible permissions object.
 * Stored in .claude/settings.json for interoperability with Claude Code CLI.
 */
export interface CCPermissions {
  /** Rules that auto-approve tool actions */
  allow?: PermissionRule[];
  /** Rules that auto-deny tool actions (highest persistent priority) */
  deny?: PermissionRule[];
  /** Rules that always prompt for confirmation */
  ask?: PermissionRule[];
  /** Default permission mode */
  defaultMode?: 'acceptEdits' | 'bypassPermissions' | 'default' | 'plan';
  /** Additional directories to include in permission scope */
  additionalDirectories?: string[];
}

/**
 * CC-compatible settings stored in .claude/settings.json.
 * These settings are shared with Claude Code CLI.
 */
export interface CCSettings {
  /** JSON Schema reference */
  $schema?: string;
  /** Tool permissions (CC format) */
  permissions?: CCPermissions;
  /** Model override */
  model?: string;
  /** Environment variables (object format) */
  env?: Record<string, string>;
  /** MCP server settings */
  enableAllProjectMcpServers?: boolean;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  /** Plugin enabled state (CC format: { "plugin-id": true/false }) */
  enabledPlugins?: Record<string, boolean>;
  /** Allow additional properties for CC compatibility */
  [key: string]: unknown;
}

// Old DEFAULT_SETTINGS constant has been moved to src/core/bootstrap/defaultSettings.ts.
// Re-exported above for backward compatibility within the Claude package.

/** Default CC-compatible settings. */
export const DEFAULT_CC_SETTINGS: CCSettings = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  permissions: {
    allow: [],
    deny: [],
    ask: [],
  },
};

/** Default CC permissions. */
export const DEFAULT_CC_PERMISSIONS: CCPermissions = {
  allow: [],
  deny: [],
  ask: [],
};

/**
 * Convert a legacy permission to CC permission rule format.
 * Examples:
 *   { toolName: "Bash", pattern: "git *" } → "Bash(git *)"
 *   { toolName: "Read", pattern: "/path/to/file" } → "Read(/path/to/file)"
 *   { toolName: "WebSearch", pattern: "*" } → "WebSearch"
 */
export function legacyPermissionToCCRule(legacy: LegacyPermission): PermissionRule {
  const pattern = legacy.pattern.trim();

  // If pattern is empty, wildcard, or JSON object (old format), just use tool name
  if (!pattern || pattern === '*' || pattern.startsWith('{')) {
    return createPermissionRule(legacy.toolName);
  }

  return createPermissionRule(`${legacy.toolName}(${pattern})`);
}

/**
 * Convert legacy permissions array to CC permissions object.
 * Only 'always' scope permissions are converted (session = ephemeral).
 */
export function legacyPermissionsToCCPermissions(
  legacyPermissions: LegacyPermission[]
): CCPermissions {
  const allow: PermissionRule[] = [];

  for (const perm of legacyPermissions) {
    if (perm.scope === 'always') {
      allow.push(legacyPermissionToCCRule(perm));
    }
  }

  return {
    allow: [...new Set(allow)],  // Deduplicate
    deny: [],
    ask: [],
  };
}

/**
 * Parse a CC permission rule into tool name and pattern.
 * Examples:
 *   "Bash(git *)" → { tool: "Bash", pattern: "git *" }
 *   "Read" → { tool: "Read", pattern: undefined }
 *   "WebFetch(domain:github.com)" → { tool: "WebFetch", pattern: "domain:github.com" }
 */
export function parseCCPermissionRule(rule: PermissionRule): {
  tool: string;
  pattern?: string;
} {
  const match = rule.match(/^(\w+)(?:\((.+)\))?$/);
  if (!match) {
    return { tool: rule };
  }

  const [, tool, pattern] = match;
  return { tool, pattern };
}
