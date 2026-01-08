/**
 * Settings type definitions.
 */

import type { ClaudeModel, ThinkingBudget } from './models';

/** Platform-specific blocked commands (Unix). */
const UNIX_BLOCKED_COMMANDS = [
  'rm -rf',
  'chmod 777',
  'chmod -R 777',
];

/** Platform-specific blocked commands (Windows - both CMD and PowerShell). */
const WINDOWS_BLOCKED_COMMANDS = [
  // CMD commands
  'del /s /q',
  'rd /s /q',
  'rmdir /s /q',
  'format',
  'diskpart',
  // PowerShell Remove-Item variants (full and abbreviated flags)
  'Remove-Item -Recurse -Force',
  'Remove-Item -Force -Recurse',
  'Remove-Item -r -fo',
  'Remove-Item -fo -r',
  'Remove-Item -Recurse',
  'Remove-Item -r',
  // PowerShell aliases for Remove-Item
  'ri -Recurse',
  'ri -r',
  'ri -Force',
  'ri -fo',
  'rm -r -fo',
  'rm -Recurse',
  'rm -Force',
  'del -Recurse',
  'del -Force',
  'erase -Recurse',
  'erase -Force',
  // PowerShell directory removal aliases
  'rd -Recurse',
  'rmdir -Recurse',
  // Dangerous disk/volume commands
  'Format-Volume',
  'Clear-Disk',
  'Initialize-Disk',
  'Remove-Partition',
];

/** Platform-keyed blocked commands structure. */
export interface PlatformBlockedCommands {
  unix: string[];
  windows: string[];
}

/** Get default blocked commands for all platforms. */
export function getDefaultBlockedCommands(): PlatformBlockedCommands {
  return {
    unix: [...UNIX_BLOCKED_COMMANDS],
    windows: [...WINDOWS_BLOCKED_COMMANDS],
  };
}

/** Get the current platform key ('unix' or 'windows'). */
export function getCurrentPlatformKey(): keyof PlatformBlockedCommands {
  return process.platform === 'win32' ? 'windows' : 'unix';
}

/** Get blocked commands for the current platform. */
export function getCurrentPlatformBlockedCommands(commands: PlatformBlockedCommands): string[] {
  return commands[getCurrentPlatformKey()];
}

/**
 * Get blocked commands for the Bash tool.
 *
 * On Windows, the Bash tool runs in a Git Bash/MSYS2 environment but can still
 * invoke Windows commands (e.g., via `cmd /c` or `powershell`), so both Unix
 * and Windows blocklist patterns are merged.
 */
export function getBashToolBlockedCommands(commands: PlatformBlockedCommands): string[] {
  if (process.platform === 'win32') {
    return Array.from(new Set([...commands.unix, ...commands.windows]));
  }
  return getCurrentPlatformBlockedCommands(commands);
}

/** Platform-specific Claude CLI paths. */
export interface PlatformCliPaths {
  macos: string;
  linux: string;
  windows: string;
}

/** Platform key for CLI paths. */
export type CliPlatformKey = keyof PlatformCliPaths;

/** Map process.platform to CLI platform key. */
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

/** Get the display name for a CLI platform key. */
export function getCliPlatformDisplayName(key: CliPlatformKey): string {
  switch (key) {
    case 'macos':
      return 'macOS';
    case 'linux':
      return 'Linux';
    case 'windows':
      return 'Windows';
  }
}

/** Get default empty CLI paths. */
export function getDefaultCliPaths(): PlatformCliPaths {
  return {
    macos: '',
    linux: '',
    windows: '',
  };
}

/** Permission mode for tool execution. */
export type PermissionMode = 'yolo' | 'normal';

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
 * @internal Use generatePermissionRule or legacyPermissionToCCRule instead.
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
  /** Allow additional properties for CC compatibility */
  [key: string]: unknown;
}

/** Saved environment variable configuration. */
export interface EnvSnippet {
  id: string;
  name: string;
  description: string;
  envVars: string;
}

/** Slash command configuration with Claude Code compatibility. */
export interface SlashCommand {
  id: string;
  name: string;                // Command name used after / (e.g., "review-code")
  description?: string;        // Optional description shown in dropdown
  argumentHint?: string;       // Placeholder text for arguments (e.g., "[file] [focus]")
  allowedTools?: string[];     // Restrict tools when command is used
  model?: ClaudeModel;         // Override model for this command
  content: string;             // Prompt template with placeholders
}

/** Keyboard navigation settings for vim-style scrolling. */
export interface KeyboardNavigationSettings {
  scrollUpKey: string;         // Key to scroll up when focused on messages (default: 'w')
  scrollDownKey: string;       // Key to scroll down when focused on messages (default: 's')
  focusInputKey: string;       // Key to focus input (default: 'i', like vim insert mode)
}

/**
 * Claudian-specific settings stored in .claude/claudian-settings.json.
 * These settings are NOT shared with Claude Code CLI.
 */
export interface ClaudianSettings {
  // User preferences
  userName: string;

  // Security (Claudian-specific, CC uses permissions.deny instead)
  enableBlocklist: boolean;
  blockedCommands: PlatformBlockedCommands;
  permissionMode: PermissionMode;

  // Model & thinking (Claudian uses enum, CC uses full model ID string)
  model: ClaudeModel;
  thinkingBudget: ThinkingBudget;
  enableAutoTitleGeneration: boolean;
  titleGenerationModel: string;  // Model for auto title generation (empty = auto)

  // Content settings
  excludedTags: string[];
  mediaFolder: string;
  systemPrompt: string;
  allowedExportPaths: string[];
  persistentExternalContextPaths: string[];  // Paths that persist across all sessions

  // Environment (string format, CC uses object format in settings.json)
  environmentVariables: string;
  envSnippets: EnvSnippet[];

  // UI settings
  keyboardNavigation: KeyboardNavigationSettings;

  // CLI paths (platform-specific)
  claudeCliPath: string;  // Legacy: single CLI path (for backwards compatibility)
  claudeCliPaths: PlatformCliPaths;  // Platform-specific CLI paths (preferred)
  loadUserClaudeSettings: boolean;  // Load ~/.claude/settings.json (may override permissions)

  // State (merged from data.json)
  activeConversationId: string | null;
  lastClaudeModel?: ClaudeModel;
  lastCustomModel?: ClaudeModel;
  lastEnvHash?: string;

  // Slash commands (loaded separately from .claude/commands/)
  slashCommands: SlashCommand[];
}

/**
 * @deprecated Use LegacyPermission instead. Kept for backward compatibility.
 */
export type Permission = LegacyPermission;

/** Default Claudian-specific settings. */
export const DEFAULT_SETTINGS: ClaudianSettings = {
  // User preferences
  userName: '',

  // Security
  enableBlocklist: true,
  blockedCommands: getDefaultBlockedCommands(),
  permissionMode: 'yolo',

  // Model & thinking
  model: 'haiku',
  thinkingBudget: 'off',
  enableAutoTitleGeneration: true,
  titleGenerationModel: '',  // Empty = auto (ANTHROPIC_DEFAULT_HAIKU_MODEL or claude-haiku-4-5)

  // Content settings
  excludedTags: [],
  mediaFolder: '',
  systemPrompt: '',
  allowedExportPaths: ['~/Desktop', '~/Downloads'],
  persistentExternalContextPaths: [],

  // Environment
  environmentVariables: '',
  envSnippets: [],

  // UI settings
  keyboardNavigation: {
    scrollUpKey: 'w',
    scrollDownKey: 's',
    focusInputKey: 'i',
  },

  // CLI paths
  claudeCliPath: '',  // Legacy field (empty = not migrated)
  claudeCliPaths: getDefaultCliPaths(),  // Platform-specific paths
  loadUserClaudeSettings: true,  // Default on for compatibility

  // State (merged from data.json)
  activeConversationId: null,
  lastClaudeModel: 'haiku',
  lastCustomModel: '',
  lastEnvHash: '',

  // Slash commands (loaded separately)
  slashCommands: [],
};

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

/** Result from instruction refinement agent query. */
export interface InstructionRefineResult {
  success: boolean;
  refinedInstruction?: string;  // The refined instruction text
  clarification?: string;       // Agent's clarifying question (if any)
  error?: string;               // Error message (if failed)
}

// ============================================================================
// Permission Conversion Utilities
// ============================================================================

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
  let skippedSessionCount = 0;

  for (const perm of legacyPermissions) {
    if (perm.scope === 'always') {
      allow.push(legacyPermissionToCCRule(perm));
    } else {
      skippedSessionCount++;
    }
  }

  if (skippedSessionCount > 0) {
    console.debug(`[Claudian] Skipped ${skippedSessionCount} session-scoped permission(s) during migration`);
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
