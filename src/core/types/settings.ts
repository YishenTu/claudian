import type { ProviderId } from '../providers/types';

/** Generic settings and command definitions shared across the app. */

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

export interface PlatformBlockedCommands {
  unix: string[];
  windows: string[];
}

export type HiddenProviderCommands = Record<ProviderId, string[]>;

export function getDefaultBlockedCommands(): PlatformBlockedCommands {
  return {
    unix: [...UNIX_BLOCKED_COMMANDS],
    windows: [...WINDOWS_BLOCKED_COMMANDS],
  };
}

export function getCurrentPlatformKey(): keyof PlatformBlockedCommands {
  return process.platform === 'win32' ? 'windows' : 'unix';
}

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

export interface ApprovalExecPolicyAmendmentDecision {
  type: 'allow-with-exec-policy-amendment';
  execPolicyAmendment: string[];
}

export interface ApprovalNetworkPolicyAmendment {
  host: string;
  action: string;
}

export interface ApprovalNetworkPolicyAmendmentDecision {
  type: 'apply-network-policy-amendment';
  networkPolicyAmendment: ApprovalNetworkPolicyAmendment;
}

/** User decision from the approval modal. */
export type ApprovalDecision =
  | 'allow'
  | 'allow-always'
  | 'deny'
  | 'cancel'
  | ApprovalExecPolicyAmendmentDecision
  | ApprovalNetworkPolicyAmendmentDecision;

/** Saved environment variable configuration. */
export interface EnvSnippet {
  id: string;
  name: string;
  description: string;
  envVars: string;
  contextLimits?: Record<string, number>;  // Optional: context limits for custom models
}

/** Source of a slash command. */
export type SlashCommandSource = 'builtin' | 'user' | 'plugin' | 'sdk';

/** Slash command configuration shared by the UI, storage, and runtime boundary. */
export interface SlashCommand {
  id: string;
  name: string;                // Command name used after / (e.g., "review-code")
  description?: string;        // Optional description shown in dropdown
  argumentHint?: string;       // Placeholder text for arguments (e.g., "[file] [focus]")
  allowedTools?: string[];     // Restrict tools when command is used
  model?: string;              // Optional provider-specific model override
  content: string;             // Prompt template with placeholders
  source?: SlashCommandSource; // Origin of the command (builtin, user, plugin, sdk)
  kind?: 'command' | 'skill';  // Explicit type — replaces id-prefix heuristic
  // Provider-owned command metadata that the UI preserves and round-trips.
  disableModelInvocation?: boolean;  // Disable model invocation for this skill
  userInvocable?: boolean;           // Whether user can invoke this skill directly
  context?: 'fork';                  // Subagent execution mode
  agent?: string;                    // Subagent type when context='fork'
  hooks?: Record<string, unknown>;   // Pass-through to SDK
}

/** Keyboard navigation settings for vim-style scrolling. */
export interface KeyboardNavigationSettings {
  scrollUpKey: string;         // Key to scroll up when focused on messages (default: 'w')
  scrollDownKey: string;       // Key to scroll down when focused on messages (default: 's')
  focusInputKey: string;       // Key to focus input (default: 'i', like vim insert mode)
}

/** Tab bar position setting. */
export type TabBarPosition = 'input' | 'header';

/** Result from instruction refinement agent query. */
export interface InstructionRefineResult {
  success: boolean;
  refinedInstruction?: string;  // The refined instruction text
  clarification?: string;       // Agent's clarifying question (if any)
  error?: string;               // Error message (if failed)
}

/** Permission mode for tool execution. */
export type PermissionMode = 'yolo' | 'plan' | 'normal';

/** Hostname-keyed CLI paths for per-device configuration. */
export type HostnameCliPaths = Record<string, string>;

/**
 * Application settings stored in .claude/claudian-settings.json.
 *
 * Provider-specific fields (model, thinkingBudget, effortLevel, etc.) use
 * `string` here.  The active provider casts internally when it needs
 * narrower types.
 */
export interface ClaudianSettings {
  // User preferences
  userName: string;

  // Security
  enableBlocklist: boolean;
  allowExternalAccess: boolean;
  blockedCommands: PlatformBlockedCommands;
  permissionMode: PermissionMode;

  // Model & thinking (provider interprets values)
  model: string;
  thinkingBudget: string;
  effortLevel: string;
  enableAutoTitleGeneration: boolean;
  titleGenerationModel: string;
  enableChrome: boolean;
  enableBangBash: boolean;
  enableOpus1M: boolean;
  enableSonnet1M: boolean;

  // Content settings
  excludedTags: string[];
  mediaFolder: string;
  systemPrompt: string;
  allowedExportPaths: string[];
  persistentExternalContextPaths: string[];

  // Environment
  environmentVariables: string;
  envSnippets: EnvSnippet[];
  customContextLimits: Record<string, number>;

  // UI settings
  keyboardNavigation: KeyboardNavigationSettings;

  // Internationalization
  locale: string;

  // CLI paths
  claudeCliPath: string;
  claudeCliPathsByHost: HostnameCliPaths;
  codexCliPath?: string;
  codexCliPathsByHost?: HostnameCliPaths;
  codexReasoningSummary?: string;  // 'auto' | 'concise' | 'detailed' | 'none'
  loadUserClaudeSettings: boolean;

  // Provider selection
  settingsProvider: string;  // ProviderId — which provider's model/effort/budget is projected to top-level fields
  codexEnabled: boolean;     // Whether the Codex provider is available
  savedProviderModel: Partial<Record<string, string>>;
  savedProviderEffort: Partial<Record<string, string>>;
  savedProviderThinkingBudget: Partial<Record<string, string>>;

  // State (provider-specific, round-tripped opaquely)
  lastClaudeModel?: string;
  lastCustomModel?: string;
  lastEnvHash?: string;

  // UI preferences
  maxTabs: number;
  tabBarPosition: TabBarPosition;
  enableAutoScroll: boolean;
  openInMainTab: boolean;

  // Provider command visibility
  hiddenProviderCommands: HiddenProviderCommands;

  // Allow provider-specific extension fields
  [key: string]: unknown;
}
