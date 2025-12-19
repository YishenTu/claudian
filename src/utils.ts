/**
 * Claudian - Utility functions
 *
 * Helper functions for vault operations, date formatting, environment parsing,
 * context file handling, and session recovery.
 */

import * as fs from 'fs';
import type { App } from 'obsidian';
import * as os from 'os';
import * as path from 'path';

import type { ChatMessage, ToolCallInfo } from './types';

// ============================================
// Date Utilities
// ============================================

/** Returns today's date in readable and ISO format for the system prompt. */
export function getTodayDate(): string {
  const now = new Date();
  const readable = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const iso = now.toISOString().split('T')[0];
  return `${readable} (${iso})`;
}

/** Returns the vault's absolute file path, or null if unavailable. */
export function getVaultPath(app: App): string | null {
  const adapter = app.vault.adapter;
  if ('basePath' in adapter) {
    return (adapter as any).basePath;
  }
  return null;
}

/** Finds Claude Code CLI executable in common install locations. */
export function findClaudeCLIPath(): string | null {
  const homeDir = os.homedir();
  const commonPaths = [
    path.join(homeDir, '.claude', 'local', 'claude'),
    path.join(homeDir, '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(homeDir, 'bin', 'claude'),
  ];

  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

/**
 * Best-effort realpath that stays symlink-aware even when the target does not exist.
 *
 * If the full path doesn't exist, resolve the nearest existing ancestor via realpath
 * and then re-append the remaining path segments.
 */
function resolveRealPath(p: string): string {
  const realpathFn = (fs.realpathSync.native ?? fs.realpathSync) as (path: fs.PathLike) => string;

  try {
    return realpathFn(p);
  } catch {
    const absolute = path.resolve(p);
    let current = absolute;
    const suffix: string[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        if (fs.existsSync(current)) {
          const resolvedExisting = realpathFn(current);
          return suffix.length > 0
            ? path.join(resolvedExisting, ...suffix.reverse())
            : resolvedExisting;
        }
      } catch {
        // Ignore and keep walking up the directory tree.
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return absolute;
      }

      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

/** Checks whether a candidate path is within the vault. */
export function isPathWithinVault(candidatePath: string, vaultPath: string): boolean {
  const vaultReal = resolveRealPath(vaultPath);

  const expandedPath = candidatePath.startsWith('~/')
    ? path.join(os.homedir(), candidatePath.slice(2))
    : candidatePath;

  const absCandidate = path.isAbsolute(expandedPath)
    ? expandedPath
    : path.resolve(vaultPath, expandedPath);

  const resolvedCandidate = resolveRealPath(absCandidate);

  return resolvedCandidate === vaultReal || resolvedCandidate.startsWith(vaultReal + path.sep);
}

/** Checks whether a candidate path is within any of the allowed export paths. */
export function isPathInAllowedExportPaths(
  candidatePath: string,
  allowedExportPaths: string[],
  vaultPath: string
): boolean {
  if (!allowedExportPaths || allowedExportPaths.length === 0) {
    return false;
  }

  // Expand and resolve the candidate path
  const expandedCandidate = candidatePath.startsWith('~/')
    ? path.join(os.homedir(), candidatePath.slice(2))
    : candidatePath;

  const absCandidate = path.isAbsolute(expandedCandidate)
    ? expandedCandidate
    : path.resolve(vaultPath, expandedCandidate);

  const resolvedCandidate = resolveRealPath(absCandidate);

  // Check if candidate is within any allowed export path
  for (const exportPath of allowedExportPaths) {
    const expandedExport = exportPath.startsWith('~/')
      ? path.join(os.homedir(), exportPath.slice(2))
      : exportPath;

    const resolvedExport = resolveRealPath(expandedExport);

    // Check if candidate equals or is within the export path
    if (
      resolvedCandidate === resolvedExport ||
      resolvedCandidate.startsWith(resolvedExport + path.sep)
    ) {
      return true;
    }
  }

  return false;
}

/** Parses KEY=VALUE environment variables from text. Supports comments (#) and empty lines. */
export function parseEnvironmentVariables(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      let value = trimmed.substring(eqIndex + 1).trim();
      // Strip surrounding quotes (single or double)
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key) {
        result[key] = value;
      }
    }
  }
  return result;
}

/** Appends a Markdown snippet to an existing prompt with sensible spacing. */
export function appendMarkdownSnippet(existingPrompt: string, snippet: string): string {
  const trimmedSnippet = snippet.trim();
  if (!trimmedSnippet) {
    return existingPrompt;
  }

  if (!existingPrompt.trim()) {
    return trimmedSnippet;
  }

  const separator = existingPrompt.endsWith('\n\n')
    ? ''
    : existingPrompt.endsWith('\n')
      ? '\n'
      : '\n\n';

  return existingPrompt + separator + trimmedSnippet;
}

// Re-export isCommandBlocked from security module for backward compatibility
export { isCommandBlocked } from './security/BlocklistChecker';

// ============================================
// Context Files
// ============================================

const CONTEXT_FILES_PREFIX_REGEX = /^Context files: \[.*?\]\n\n/;

/** Formats a context files line for the prompt. */
export function formatContextFilesLine(files: string[]): string {
  return `Context files: [${files.join(', ')}]`;
}

/** Prepends context files to a prompt. */
export function prependContextFiles(prompt: string, files: string[]): string {
  return `${formatContextFilesLine(files)}\n\n${prompt}`;
}

/** Strips context files prefix from a prompt. */
export function stripContextFilesPrefix(prompt: string): string {
  return prompt.replace(CONTEXT_FILES_PREFIX_REGEX, '');
}

// ============================================
// Session Recovery
// ============================================

/**
 * Error patterns that indicate session needs recovery.
 */
const SESSION_ERROR_PATTERNS = [
  'session expired',
  'session not found',
  'invalid session',
  'session invalid',
  'process exited with code',
] as const;

const SESSION_ERROR_COMPOUND_PATTERNS = [
  { includes: ['session', 'expired'] },
  { includes: ['resume', 'failed'] },
  { includes: ['resume', 'error'] },
] as const;

/** Checks if an error indicates session needs recovery. */
export function isSessionExpiredError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : '';

  for (const pattern of SESSION_ERROR_PATTERNS) {
    if (msg.includes(pattern)) {
      return true;
    }
  }

  for (const { includes } of SESSION_ERROR_COMPOUND_PATTERNS) {
    if (includes.every(part => msg.includes(part))) {
      return true;
    }
  }

  return false;
}

// ============================================
// History Reconstruction
// ============================================

/** Formats a tool call for inclusion in rebuilt context. */
export function formatToolCallForContext(toolCall: ToolCallInfo, maxResultLength = 800): string {
  const status = toolCall.status ?? 'completed';
  const base = `[Tool ${toolCall.name} status=${status}]`;
  const hasResult = typeof toolCall.result === 'string' && toolCall.result.trim().length > 0;

  if (!hasResult) {
    return base;
  }

  const result = truncateToolResult(toolCall.result as string, maxResultLength);
  return `${base} result: ${result}`;
}

/** Truncates tool result to avoid overloading recovery prompt. */
export function truncateToolResult(result: string, maxLength = 800): string {
  if (result.length > maxLength) {
    return `${result.slice(0, maxLength)}... (truncated)`;
  }
  return result;
}

/** Formats a context line for user messages when rebuilding history. */
export function formatContextLine(message: ChatMessage): string | null {
  if (!message.contextFiles || message.contextFiles.length === 0) {
    return null;
  }
  return formatContextFilesLine(message.contextFiles);
}

/**
 * Builds conversation context from message history for session recovery.
 */
export function buildContextFromHistory(messages: ChatMessage[]): string {
  const parts: string[] = [];

  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue;
    }

    if (message.role === 'assistant') {
      const hasContent = message.content && message.content.trim().length > 0;
      const hasToolResult = message.toolCalls?.some(
        tc => tc.result && tc.result.trim().length > 0
      );
      if (!hasContent && !hasToolResult) {
        continue;
      }
    }

    const role = message.role === 'user' ? 'User' : 'Assistant';
    const lines: string[] = [];
    const content = message.content?.trim();
    const contextLine = formatContextLine(message);

    const userPayload = contextLine
      ? content
        ? `${contextLine}\n\n${content}`
        : contextLine
      : content;

    lines.push(userPayload ? `${role}: ${userPayload}` : `${role}:`);

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const toolLines = message.toolCalls
        .map(tc => formatToolCallForContext(tc))
        .filter(Boolean) as string[];
      if (toolLines.length > 0) {
        lines.push(...toolLines);
      }
    }

    parts.push(lines.join('\n'));
  }

  return parts.join('\n\n');
}

/** Gets the last user message from conversation history. */
export function getLastUserMessage(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages[i];
    }
  }
  return undefined;
}

/** Extracts model options from ANTHROPIC_* environment variables, deduplicated by value. */
export function getModelsFromEnvironment(envVars: Record<string, string>): { value: string; label: string; description: string }[] {
  const modelMap = new Map<string, { types: string[]; label: string }>();

  const modelEnvEntries: { type: string; envKey: string }[] = [
    { type: 'model', envKey: 'ANTHROPIC_MODEL' },
    { type: 'opus', envKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL' },
    { type: 'sonnet', envKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL' },
    { type: 'haiku', envKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' },
  ];

  for (const { type, envKey } of modelEnvEntries) {
    const modelValue = envVars[envKey];
    if (modelValue) {
      const label = modelValue.includes('/')
        ? modelValue.split('/').pop() || modelValue
        : modelValue.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

      if (!modelMap.has(modelValue)) {
        modelMap.set(modelValue, { types: [type], label });
      } else {
        modelMap.get(modelValue)!.types.push(type);
      }
    }
  }

  const models: { value: string; label: string; description: string }[] = [];
  const typePriority = { 'model': 4, 'haiku': 3, 'sonnet': 2, 'opus': 1 };

  const sortedEntries = Array.from(modelMap.entries()).sort(([, aInfo], [, bInfo]) => {
    const aPriority = Math.max(...aInfo.types.map(t => typePriority[t as keyof typeof typePriority] || 0));
    const bPriority = Math.max(...bInfo.types.map(t => typePriority[t as keyof typeof typePriority] || 0));
    return bPriority - aPriority;
  });

  for (const [modelValue, info] of sortedEntries) {
    const sortedTypes = info.types.sort((a, b) =>
      (typePriority[b as keyof typeof typePriority] || 0) -
      (typePriority[a as keyof typeof typePriority] || 0)
    );

    models.push({
      value: modelValue,
      label: info.label,
      description: `Custom model (${sortedTypes.join(', ')})`
    });
  }

  return models;
}

/** Returns the highest-priority custom model from environment variables, or null. */
export function getCurrentModelFromEnvironment(envVars: Record<string, string>): string | null {
  if (envVars.ANTHROPIC_MODEL) {
    return envVars.ANTHROPIC_MODEL;
  }
  if (envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  }
  if (envVars.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return envVars.ANTHROPIC_DEFAULT_SONNET_MODEL;
  }
  if (envVars.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    return envVars.ANTHROPIC_DEFAULT_OPUS_MODEL;
  }
  return null;
}
