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

/**
 * Checks if a path starts with home directory notation (~/path or ~\path).
 * Supports both Unix-style (~/) and Windows-style (~\) home directory notation.
 */
export function startsWithHomePath(p: string): boolean {
  return p.startsWith('~/') || p.startsWith('~\\') || p === '~';
}

function getEnvValue(key: string): string | undefined {
  const hasKey = (name: string) => Object.prototype.hasOwnProperty.call(process.env, name);

  if (hasKey(key)) {
    return process.env[key];
  }

  if (process.platform !== 'win32') {
    return undefined;
  }

  const upper = key.toUpperCase();
  if (hasKey(upper)) {
    return process.env[upper];
  }

  const lower = key.toLowerCase();
  if (hasKey(lower)) {
    return process.env[lower];
  }

  const matchKey = Object.keys(process.env).find((name) => name.toLowerCase() === key.toLowerCase());
  return matchKey ? process.env[matchKey] : undefined;
}

function expandEnvironmentVariables(value: string): string {
  if (!value.includes('%') && !value.includes('$') && !value.includes('!')) {
    return value;
  }

  const isWindows = process.platform === 'win32';
  let expanded = value;

  // Windows %VAR% format - allow parentheses for vars like %ProgramFiles(x86)%
  expanded = expanded.replace(/%([A-Za-z_][A-Za-z0-9_()]*[A-Za-z0-9_)]?)%/g, (match, name) => {
    const envValue = getEnvValue(name);
    return envValue !== undefined ? envValue : match;
  });

  if (isWindows) {
    expanded = expanded.replace(/!([A-Za-z_][A-Za-z0-9_]*)!/g, (match, name) => {
      const envValue = getEnvValue(name);
      return envValue !== undefined ? envValue : match;
    });

    expanded = expanded.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (match, name) => {
      const envValue = getEnvValue(name);
      return envValue !== undefined ? envValue : match;
    });
  }

  expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name1, name2) => {
    const key = name1 ?? name2;
    if (!key) return match;
    const envValue = getEnvValue(key);
    return envValue !== undefined ? envValue : match;
  });

  return expanded;
}

/**
 * Expands home directory notation to absolute path.
 * Handles both ~/path and ~\path formats.
 */
export function expandHomePath(p: string): string {
  const expanded = expandEnvironmentVariables(p);
  if (expanded === '~') {
    return os.homedir();
  }
  if (expanded.startsWith('~/')) {
    return path.join(os.homedir(), expanded.slice(2));
  }
  if (expanded.startsWith('~\\')) {
    return path.join(os.homedir(), expanded.slice(2));
  }
  return expanded;
}

/** Finds Claude Code CLI executable in common install locations. */
export function findClaudeCLIPath(): string | null {
  const homeDir = os.homedir();
  const isWindows = process.platform === 'win32';

  // Platform-specific search paths
  const commonPaths: string[] = isWindows
    ? [
        // Windows paths
        path.join(homeDir, '.claude', 'local', 'claude.exe'),
        path.join(homeDir, 'AppData', 'Local', 'Claude', 'claude.exe'),
        path.join(homeDir, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Claude', 'claude.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Claude', 'claude.exe'),
        path.join(homeDir, '.local', 'bin', 'claude.exe'),
      ]
    : [
        // Unix/macOS paths
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

/**
 * Translates MSYS/Git Bash paths to Windows paths.
 * E.g., /c/Users/... → C:\Users\...
 *
 * This must be called BEFORE path.resolve() or path.isAbsolute() checks,
 * as those functions don't recognize MSYS-style drive paths.
 */
export function translateMsysPath(value: string): string {
  if (process.platform !== 'win32') {
    return value;
  }

  // Match /c/... or /C/... (single letter drive)
  const msysMatch = value.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (msysMatch) {
    const driveLetter = msysMatch[1].toUpperCase();
    const restOfPath = msysMatch[2] ?? '';
    // Convert forward slashes to backslashes for the rest of the path
    return `${driveLetter}:${restOfPath.replace(/\//g, '\\')}`;
  }

  return value;
}

/**
 * Normalizes a path for cross-platform use before resolution.
 * Handles MSYS path translation and home directory expansion.
 * Call this before path.resolve() or path.isAbsolute() checks.
 */
function normalizePathBeforeResolution(p: string): string {
  // First expand environment variables and home path
  const expanded = expandHomePath(p);
  // Then translate MSYS paths on Windows (must happen before path.resolve)
  return translateMsysPath(expanded);
}

function normalizeWindowsPathPrefix(value: string): string {
  if (process.platform !== 'win32') {
    return value;
  }

  // First translate MSYS/Git Bash paths
  const normalized = translateMsysPath(value);

  if (normalized.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${normalized.slice('\\\\?\\UNC\\'.length)}`;
  }

  if (normalized.startsWith('\\\\?\\')) {
    return normalized.slice('\\\\?\\'.length);
  }

  return normalized;
}

function normalizePathForComparison(value: string): string {
  if (!value || typeof value !== 'string') {
    return '';
  }
  try {
    const normalized = normalizeWindowsPathPrefix(path.normalize(value));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  } catch {
    // Fallback to input if normalization fails
    return process.platform === 'win32' ? value.toLowerCase() : value;
  }
}

/** Checks whether a candidate path is within the vault. */
export function isPathWithinVault(candidatePath: string, vaultPath: string): boolean {
  const vaultReal = normalizePathForComparison(resolveRealPath(vaultPath));

  // Normalize before resolution to handle MSYS paths on Windows
  const normalizedPath = normalizePathBeforeResolution(candidatePath);

  const absCandidate = path.isAbsolute(normalizedPath)
    ? normalizedPath
    : path.resolve(vaultPath, normalizedPath);

  const resolvedCandidate = normalizePathForComparison(resolveRealPath(absCandidate));

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

  // Normalize before resolution to handle MSYS paths on Windows
  const normalizedCandidate = normalizePathBeforeResolution(candidatePath);

  const absCandidate = path.isAbsolute(normalizedCandidate)
    ? normalizedCandidate
    : path.resolve(vaultPath, normalizedCandidate);

  const resolvedCandidate = normalizePathForComparison(resolveRealPath(absCandidate));

  // Check if candidate is within any allowed export path
  for (const exportPath of allowedExportPaths) {
    const normalizedExport = normalizePathBeforeResolution(exportPath);

    const resolvedExport = normalizePathForComparison(resolveRealPath(normalizedExport));

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

/** Checks whether a candidate path is within any of the allowed context paths (read-only). */
export function isPathInAllowedContextPaths(
  candidatePath: string,
  allowedContextPaths: string[],
  vaultPath: string
): boolean {
  if (!allowedContextPaths || allowedContextPaths.length === 0) {
    return false;
  }

  // Normalize before resolution to handle MSYS paths on Windows
  const normalizedCandidate = normalizePathBeforeResolution(candidatePath);

  const absCandidate = path.isAbsolute(normalizedCandidate)
    ? normalizedCandidate
    : path.resolve(vaultPath, normalizedCandidate);

  const resolvedCandidate = normalizePathForComparison(resolveRealPath(absCandidate));

  // Check if candidate is within any allowed context path
  for (const contextPath of allowedContextPaths) {
    const normalizedContext = normalizePathBeforeResolution(contextPath);

    const resolvedContext = normalizePathForComparison(resolveRealPath(normalizedContext));

    // Check if candidate equals or is within the context path
    if (
      resolvedCandidate === resolvedContext ||
      resolvedCandidate.startsWith(resolvedContext + path.sep)
    ) {
      return true;
    }
  }

  return false;
}

export type PathAccessType = 'vault' | 'readwrite' | 'context' | 'export' | 'none';

/**
 * Resolve access type for a candidate path with context/export overlap handling.
 * The most specific matching root wins; exact context+export matches are read-write.
 */
export function getPathAccessType(
  candidatePath: string,
  allowedContextPaths: string[] | undefined,
  allowedExportPaths: string[] | undefined,
  vaultPath: string
): PathAccessType {
  if (!candidatePath) return 'none';

  const vaultReal = normalizePathForComparison(resolveRealPath(vaultPath));

  // Normalize before resolution to handle MSYS paths on Windows
  const normalizedCandidate = normalizePathBeforeResolution(candidatePath);

  const absCandidate = path.isAbsolute(normalizedCandidate)
    ? normalizedCandidate
    : path.resolve(vaultPath, normalizedCandidate);

  const resolvedCandidate = normalizePathForComparison(resolveRealPath(absCandidate));

  if (resolvedCandidate === vaultReal || resolvedCandidate.startsWith(vaultReal + path.sep)) {
    return 'vault';
  }

  const roots = new Map<string, { context: boolean; export: boolean }>();

  const addRoot = (rawPath: string, kind: 'context' | 'export') => {
    const trimmed = rawPath.trim();
    if (!trimmed) return;
    // Normalize before resolution to handle MSYS paths on Windows
    const normalized = normalizePathBeforeResolution(trimmed);
    const resolved = normalizePathForComparison(resolveRealPath(normalized));
    const existing = roots.get(resolved) ?? { context: false, export: false };
    existing[kind] = true;
    roots.set(resolved, existing);
  };

  for (const contextPath of allowedContextPaths ?? []) {
    addRoot(contextPath, 'context');
  }

  for (const exportPath of allowedExportPaths ?? []) {
    addRoot(exportPath, 'export');
  }

  let bestRoot: string | null = null;
  let bestFlags: { context: boolean; export: boolean } | null = null;

  for (const [root, flags] of roots) {
    if (resolvedCandidate === root || resolvedCandidate.startsWith(root + path.sep)) {
      if (!bestRoot || root.length > bestRoot.length) {
        bestRoot = root;
        bestFlags = flags;
      }
    }
  }

  if (!bestRoot || !bestFlags) return 'none';
  if (bestFlags.context && bestFlags.export) return 'readwrite';
  if (bestFlags.context) return 'context';
  if (bestFlags.export) return 'export';
  return 'none';
}

/** Parses KEY=VALUE environment variables from text. Supports comments (#) and empty lines. */
export function parseEnvironmentVariables(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Handle both Unix (LF) and Windows (CRLF) line endings
  for (const line of input.split(/\r?\n/)) {
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

const CONTEXT_FILES_PREFIX_REGEX = /^<context_files>\n[\s\S]*?<\/context_files>\n\n/;

/** Formats context files in XML format. */
export function formatContextFilesLine(files: string[]): string {
  return `<context_files>\n${files.join(', ')}\n</context_files>`;
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
// Editor Context
// ============================================

export interface CursorContext {
  beforeCursor: string;
  afterCursor: string;
  isInbetween: boolean;
  line: number;
  column: number;
}

export interface EditorSelectionContext {
  notePath: string;
  mode: 'selection' | 'cursor' | 'none';
  selectedText?: string;
  cursorContext?: CursorContext;
  lineCount?: number; // Number of lines in selection (for UI indicator)
  startLine?: number; // 1-indexed starting line number
}

/** Helper to find nearest non-empty line in a direction. */
export function findNearestNonEmptyLine(
  getLine: (line: number) => string,
  lineCount: number,
  startLine: number,
  direction: 'before' | 'after'
): string {
  const step = direction === 'before' ? -1 : 1;
  for (let i = startLine + step; i >= 0 && i < lineCount; i += step) {
    const content = getLine(i);
    if (content.trim().length > 0) {
      return content;
    }
  }
  return '';
}

/**
 * Builds cursor context for inline edit cursor mode.
 * @param getLine Function to get line content by index (0-indexed)
 * @param lineCount Total number of lines in document
 * @param line Cursor line (0-indexed)
 * @param column Cursor column
 */
export function buildCursorContext(
  getLine: (line: number) => string,
  lineCount: number,
  line: number,
  column: number
): CursorContext {
  const lineContent = getLine(line);
  const beforeCursor = lineContent.substring(0, column);
  const afterCursor = lineContent.substring(column);

  const lineIsEmpty = lineContent.trim().length === 0;
  const nothingBefore = beforeCursor.trim().length === 0;
  const nothingAfter = afterCursor.trim().length === 0;
  const isInbetween = lineIsEmpty || (nothingBefore && nothingAfter);

  let contextBefore = beforeCursor;
  let contextAfter = afterCursor;

  if (isInbetween) {
    // Find nearest non-empty line before cursor
    contextBefore = findNearestNonEmptyLine(getLine, lineCount, line, 'before');
    // Find nearest non-empty line after cursor
    contextAfter = findNearestNonEmptyLine(getLine, lineCount, line, 'after');
  }

  return { beforeCursor: contextBefore, afterCursor: contextAfter, isInbetween, line, column };
}

/** Formats editor context in XML format. */
export function formatEditorContext(context: EditorSelectionContext): string {
  if (context.mode === 'selection' && context.selectedText) {
    const lineAttr = context.startLine && context.lineCount
      ? ` lines="${context.startLine}-${context.startLine + context.lineCount - 1}"`
      : '';
    return `<editor_selection path="${context.notePath}"${lineAttr}>\n${context.selectedText}\n</editor_selection>`;
  } else if (context.mode === 'cursor' && context.cursorContext) {
    const ctx = context.cursorContext;
    let content: string;
    if (ctx.isInbetween) {
      const parts = [];
      if (ctx.beforeCursor) parts.push(ctx.beforeCursor);
      parts.push('| #inbetween');
      if (ctx.afterCursor) parts.push(ctx.afterCursor);
      content = parts.join('\n');
    } else {
      content = `${ctx.beforeCursor}|${ctx.afterCursor} #inline`;
    }
    return `<editor_cursor path="${context.notePath}">\n${content}\n</editor_cursor>`;
  }
  return '';
}

/** Prepends editor context to a prompt. */
export function prependEditorContext(prompt: string, context: EditorSelectionContext): string {
  const formatted = formatEditorContext(context);
  return formatted ? `${formatted}\n\n${prompt}` : prompt;
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
