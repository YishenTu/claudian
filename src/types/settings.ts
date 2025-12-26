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
  // PowerShell commands
  'Remove-Item -Recurse -Force',
  'Remove-Item -r -fo',
  'rm -r -fo',
  'Format-Volume',
  'Clear-Disk',
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
 * On Windows, the Bash tool runs in a Git Bash/MSYS2 environment,
 * so use Unix blocklist patterns.
 */
export function getBashToolBlockedCommands(commands: PlatformBlockedCommands): string[] {
  return process.platform === 'win32' ? commands.unix : getCurrentPlatformBlockedCommands(commands);
}

/** Permission mode for tool execution. */
export type PermissionMode = 'yolo' | 'normal';

/** Permanently approved tool permission (like Claude Code). */
export interface Permission {
  toolName: string;
  pattern: string;
  approvedAt: number;
  scope: 'session' | 'always';
}

/** @deprecated Use Permission instead */
export type ApprovedAction = Permission;

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

/** Plugin settings persisted to disk. */
export interface ClaudianSettings {
  userName: string;
  enableBlocklist: boolean;
  blockedCommands: PlatformBlockedCommands;
  showToolUse: boolean;
  toolCallExpandedByDefault: boolean;
  model: ClaudeModel;
  lastClaudeModel?: ClaudeModel;
  lastCustomModel?: ClaudeModel;
  lastEnvHash?: string;
  thinkingBudget: ThinkingBudget;
  permissionMode: PermissionMode;
  permissions: Permission[];
  excludedTags: string[];
  mediaFolder: string;
  environmentVariables: string;
  envSnippets: EnvSnippet[];
  systemPrompt: string;
  allowedExportPaths: string[];
  allowedContextPaths: string[];
  slashCommands: SlashCommand[];
}

/** Default plugin settings. */
export const DEFAULT_SETTINGS: ClaudianSettings = {
  userName: '',
  enableBlocklist: true,
  blockedCommands: getDefaultBlockedCommands(),
  showToolUse: true,
  toolCallExpandedByDefault: false,
  model: 'haiku',
  lastClaudeModel: 'haiku',
  lastCustomModel: '',
  lastEnvHash: '',
  thinkingBudget: 'off',
  permissionMode: 'yolo',
  permissions: [],
  excludedTags: [],
  mediaFolder: '',
  environmentVariables: '',
  envSnippets: [],
  systemPrompt: '',
  allowedExportPaths: ['~/Desktop', '~/Downloads'],
  allowedContextPaths: [],
  slashCommands: [],
};

/** Result from instruction refinement agent query. */
export interface InstructionRefineResult {
  success: boolean;
  refinedInstruction?: string;  // The refined instruction text
  clarification?: string;       // Agent's clarifying question (if any)
  error?: string;               // Error message (if failed)
}
