/**
 * Settings type definitions.
 */

import type { ClaudeModel, ThinkingBudget } from './models';

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
  blockedCommands: string[];
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
  blockedCommands: [
    'rm -rf',
    'chmod 777',
    'chmod -R 777',
  ],
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
